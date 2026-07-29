#!/usr/bin/env bash
#
# Shared host/container operation lock.
#
# The live checkout's .git directory is bind-mounted into the CMS container,
# so this flock coordinates Docker maintenance, backups, cron publishers, and
# the CMS's own Git publish path against the same inode. The descriptor remains
# open (and inherited by child processes) until the caller exits.

acquire_wwwide_operation_lock() {
  local app_dir="${1:?app directory is required}"
  local mode="${2:-skip}"
  local timeout="${3:-300}"
  local lock_file

  # A parent maintenance script already owns the inherited descriptor.
  if [ "${WWWIDE_OPERATION_LOCK_HELD:-0}" = "1" ]; then
    return 0
  fi

  if ! command -v flock >/dev/null 2>&1; then
    echo "$(date -Is) [operation-lock] flock is unavailable; refusing an uncoordinated run." >&2
    return 2
  fi
  if [ ! -d "$app_dir/.git" ]; then
    echo "$(date -Is) [operation-lock] missing Git directory at $app_dir/.git." >&2
    return 2
  fi

  lock_file="${WWWIDE_OPERATION_LOCK_FILE:-$app_dir/.git/wwwide-operation.lock}"
  exec 9>"$lock_file"

  if [ "$mode" = "wait" ]; then
    if ! flock -x -w "$timeout" 9; then
      echo "$(date -Is) [operation-lock] another CMS operation exceeded ${timeout}s; aborting." >&2
      return 1
    fi
  elif ! flock -x -n 9; then
    echo "$(date -Is) [operation-lock] another CMS operation is active; deferring this run."
    return 1
  fi

  export WWWIDE_OPERATION_LOCK_HELD=1
}
