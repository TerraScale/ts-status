#!/usr/bin/env bash
# Runs every argument as a shell command at the same time, then prints each
# command's output as its own log group, in argument order. Fails when any
# command fails.
set -uo pipefail

logs=$(mktemp -d)
trap 'rm -rf "$logs"' EXIT

pids=()
index=0
for command in "$@"; do
	bash -c "$command" >"$logs/$index" 2>&1 &
	pids+=("$!")
	index=$((index + 1))
done

failed=0
index=0
for command in "$@"; do
	status=0
	wait "${pids[$index]}" || status=$?
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
