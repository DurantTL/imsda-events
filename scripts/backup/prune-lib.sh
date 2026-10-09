#!/bin/sh
# Shared by pg-backup.sh and assets-backup.sh (sourced, not run).
#
# prune_backups DIR GLOB DAYS: deletes files matching GLOB in DIR older than
# DAYS days, but always keeps the newest BACKUP_KEEP_MIN (default 3) matching
# files however old they are, so an outage longer than the retention window
# cannot delete the last good backups.
prune_backups() {
  _dir="$1"
  _glob="$2"
  _days="$3"
  _keep="${BACKUP_KEEP_MIN:-3}"
  for _file in $(ls -1t "${_dir}"/${_glob} 2>/dev/null | tail -n +"$((_keep + 1))"); do
    if [ -n "$(find "${_file}" -mtime "+${_days}" 2>/dev/null)" ]; then
      echo "${_file}"
      rm -f "${_file}"
    fi
  done
}
