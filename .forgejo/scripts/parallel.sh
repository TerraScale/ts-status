#!/usr/bin/env bash
# Runs every argument as a shell command at the same time, then prints each
# command's output as its own log group, in argument order. Cancellation
# flushes pending logs; failures preserve the first nonzero command status.
set -uo pipefail

commands=("$@")
printed=()
pids=()
registering=0
cancel_status=0
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC2329 # Invoked by the INT/TERM traps.
request_cancel() {
	cancel_status=$1
	if ((registering == 0)); then exit "$cancel_status"; fi
}
print_log() {
	local index=$1 status=$2
	echo "::group::${commands[$index]} (exit $status)"
	cat "$logs/$index"
	echo "::endgroup::"
	printed[index]=1
}
logs=$(mktemp -d) || exit 1
# shellcheck disable=SC2329 # Invoked by the EXIT trap.
cleanup() {
	trap '' INT TERM
	if ((${#pids[@]})); then
		for pid in "${pids[@]}"; do
			kill -TERM -- "-$pid" "$pid" 2>/dev/null || true
		done
		sleep 2
		for pid in "${pids[@]}"; do
			kill -KILL -- "-$pid" "$pid" 2>/dev/null || true
			wait "$pid" 2>/dev/null || true
		done
	fi
	for index in "${!commands[@]}"; do
		if [[ ${printed[$index]:-0} != 1 && -f $logs/$index ]]; then
			print_log "$index" interrupted
		fi
	done
	rm -rf -- "$logs"
}
trap 'cleanup' EXIT
trap 'request_cancel 130' INT
trap 'request_cancel 143' TERM

index=0
for command in "$@"; do
	mkfifo "$logs/$index.control" || exit 1
	# Defer cancellation until the newly launched supervisor is registered.
	registering=1
	setsid bash "$script_dir/supervise.sh" "$command" "$logs/$index.status" "$logs/$index.control" >"$logs/$index" 2>&1 &
	pids+=("$!")
	registering=0
	if ((cancel_status != 0)); then exit "$cancel_status"; fi
	index=$((index + 1))
done

failed=0
index=0
for command in "$@"; do
	while [[ ! -f $logs/$index.status ]]; do sleep 0.02; done
	read -r status < "$logs/$index.status"
	# The supervisor remains alive after command completion. Stop its group
	# before reaping it, so its numeric group ID cannot be reused meanwhile.
	kill -KILL -- "-${pids[$index]}" "${pids[$index]}" 2>/dev/null || true
	wait "${pids[$index]}" 2>/dev/null || true
	unset 'pids[index]'
	print_log "$index" "$status"
	if ((status != 0)); then
		echo "::error::$command failed with exit status $status"
		if ((failed == 0)); then failed=$status; fi
	fi
	index=$((index + 1))
done
exit "$failed"
