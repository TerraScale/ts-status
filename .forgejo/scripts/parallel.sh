#!/usr/bin/env bash
# Runs every argument as a shell command at the same time, then prints each
# command's output as its own log group, in argument order. Fails when any
# command fails.
set -uo pipefail

pids=()
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
	echo "::group::$command (exit $status)"
	cat "$logs/$index"
	echo "::endgroup::"
	if ((status != 0)); then
		echo "::error::$command failed with exit status $status"
		failed=1
	fi
	index=$((index + 1))
done
exit "$failed"
