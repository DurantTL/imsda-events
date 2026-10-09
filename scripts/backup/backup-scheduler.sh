#!/bin/sh
# Runs the nightly backup, and a restore rehearsal every Nth run.
#
# Kept as a sleep loop rather than cron so the container has one process, logs
# to stdout like everything else, and needs no image with a cron daemon.
#
# After every run it records a status row (record-status.sh) that /api/health
# reads: times, sizes, off-site ok/failed and the rehearsal result. Recording
# is best effort; a failure to record is logged and never stops backups.
#
# Environment (besides what the other scripts read):
#   BACKUP_INTERVAL_SECONDS  seconds between runs (default 86400)
#   BACKUP_VERIFY_EVERY      rehearse a restore every Nth run (default 7)
#   BACKUP_RUN_ONCE          set to 1 to run a single cycle and exit (tests,
#                            and a manual "back up now")
#   BACKUP_SCRIPT_DIR        where the sibling scripts live (default: this dir)
set -eu

INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"
VERIFY_EVERY="${BACKUP_VERIFY_EVERY:-7}"
SCRIPT_DIR="${BACKUP_SCRIPT_DIR:-$(cd "$(dirname "$0")" && pwd)}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
STATE_DIR="${BACKUP_STATE_DIR:-${BACKUP_DIR}/.status}"
export BACKUP_DIR BACKUP_STATE_DIR="${STATE_DIR}"
RUN=0

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# state_get FILE KEY: value of KEY=VALUE from a state file the scripts wrote.
state_get() {
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | head -n 1
}

record() {
  "${SCRIPT_DIR}/record-status.sh" "$@" || \
    echo "[backup-scheduler] could not record status; health will not show this run." >&2
}

run_cycle() {
  STARTED="$(now)"
  mkdir -p "${STATE_DIR}"
  rm -f "${STATE_DIR}/pg.state" "${STATE_DIR}/assets.state"

  # Each script also exits non-zero for a failed off-site copy, so success of
  # the local file is judged from the state it leaves, not the exit status.
  "${SCRIPT_DIR}/pg-backup.sh" || \
    echo "[backup-scheduler] database backup reported a failure." >&2
  DUMP_BYTES="$(state_get "${STATE_DIR}/pg.state" BYTES)"

  ASSETS_BYTES=""
  if [ -n "${DUMP_BYTES}" ]; then
    "${SCRIPT_DIR}/assets-backup.sh" || \
      echo "[backup-scheduler] asset backup reported a failure." >&2
    ASSETS_BYTES="$(state_get "${STATE_DIR}/assets.state" BYTES)"
  fi

  OK=false
  if [ -n "${DUMP_BYTES}" ] && [ -n "${ASSETS_BYTES}" ]; then OK=true; fi

  # Off-site: failed if any copy failed, ok if every attempted copy worked,
  # empty (unknown) if none is configured.
  PG_OFF="$(state_get "${STATE_DIR}/pg.state" OFFSITE)"
  AS_OFF="$(state_get "${STATE_DIR}/assets.state" OFFSITE)"
  OFFSITE=""
  case "${PG_OFF}:${AS_OFF}" in
    *failed*) OFFSITE=false ;;
    ok:ok) OFFSITE=true ;;
  esac
  # A missing archive means the off-site set is incomplete.
  if [ -z "${ASSETS_BYTES}" ] && [ "${OFFSITE}" = "true" ]; then OFFSITE=false; fi

  record BACKUP "${OK}" "${STARTED}" "$(now)" "${DUMP_BYTES}" "${ASSETS_BYTES}" "${OFFSITE}"
  if [ "${OK}" != "true" ]; then
    echo "[backup-scheduler] backup failed; retrying at the next interval." >&2
  fi

  if [ -n "${DUMP_BYTES}" ] && \
     { [ "$((RUN % VERIFY_EVERY))" -eq 1 ] || [ "${VERIFY_EVERY}" -eq 1 ]; }; then
    # A failed rehearsal must be loud but must not stop future backups.
    R_STARTED="$(now)"
    if "${SCRIPT_DIR}/pg-restore-verify.sh"; then
      record REHEARSAL true "${R_STARTED}" "$(now)"
    else
      echo "[backup-scheduler] RESTORE REHEARSAL FAILED — the backups are not proven restorable." >&2
      record REHEARSAL false "${R_STARTED}" "$(now)"
    fi
  fi
}

echo "[backup-scheduler] backing up every ${INTERVAL_SECONDS}s, rehearsing a restore every ${VERIFY_EVERY} runs"

while true; do
  RUN=$((RUN + 1))
  run_cycle
  if [ "${BACKUP_RUN_ONCE:-0}" = "1" ]; then
    exit 0
  fi
  sleep "${INTERVAL_SECONDS}"
done
