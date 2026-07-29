#!/bin/sh
# Runs the nightly backup, and a restore rehearsal every Nth run.
#
# Kept as a sleep loop rather than cron so the container has one process, logs
# to stdout like everything else, and needs no image with a cron daemon.
set -eu

INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"
VERIFY_EVERY="${BACKUP_VERIFY_EVERY:-7}"
RUN=0

echo "[backup-scheduler] backing up every ${INTERVAL_SECONDS}s, rehearsing a restore every ${VERIFY_EVERY} runs"

while true; do
  RUN=$((RUN + 1))

  if /usr/local/bin/pg-backup.sh; then
    /usr/local/bin/assets-backup.sh || \
      echo "[backup-scheduler] asset backup failed; retrying at the next interval." >&2

    if [ "$((RUN % VERIFY_EVERY))" -eq 1 ] || [ "${VERIFY_EVERY}" -eq 1 ]; then
      # A failed rehearsal must be loud but must not stop future backups.
      /usr/local/bin/pg-restore-verify.sh || \
        echo "[backup-scheduler] RESTORE REHEARSAL FAILED — the backups are not proven restorable." >&2
    fi
  else
    echo "[backup-scheduler] backup failed; retrying at the next interval." >&2
  fi

  sleep "${INTERVAL_SECONDS}"
done
