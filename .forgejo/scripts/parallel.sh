#!/usr/bin/env bash
# Runs every argument as a shell command at the same time, then prints each
# command's output as its own log group, in argument order. Cancellation
# flushes pending logs; failures preserve the first nonzero command status.
set -uo pipefail

commands=("$@")
printed=()
pids=()
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
trap 'exit 130' INT
trap 'exit 143' TERM

index=0
for command in "$@"; do
	setsid bash -o pipefail -c "$command" >"$logs/$index" 2>&1 &
	pids+=("$!")
	index=$((index + 1))
done

failed=0
index=0
for command in "$@"; do
	status=0
	wait "${pids[$index]}" || status=$?
	# A command can finish while its background workers still own the group.
	kill -TERM -- "-${pids[$index]}" 2>/dev/null || true
	if kill -0 -- "-${pids[$index]}" 2>/dev/null; then
		sleep 2
		kill -KILL -- "-${pids[$index]}" 2>/dev/null || true
	fi
	unset 'pids[index]'
	print_log "$index" "$status"
	if ((status != 0)); then
		echo "::error::$command failed with exit status $status"
		if ((failed == 0)); then failed=$status; fi
	fi
	index=$((index + 1))
done
exit "$failed"
