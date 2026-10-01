#!/usr/bin/env bash
# Keep a worker's process-group leader alive until parallel.sh tears it down.
# Normal completion is recorded separately, before blocking on the control FIFO.
set -uo pipefail
command=${1:?command is required}
status_file=${2:?status file is required}
control=${3:?control FIFO is required}
# A caught signal keeps this supervisor alive without making exec'd children
# inherit an ignored TERM disposition. Cancellation ends the owned group later.
trap ':' INT TERM
bash -o pipefail -c "$command" &
worker=$!
status=0
wait "$worker" || status=$?
printf '%s\n' "$status" > "$status_file.tmp"
mv -- "$status_file.tmp" "$status_file"
while :; do read -r < "$control" || true; done
