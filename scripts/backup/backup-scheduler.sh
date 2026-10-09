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
# A run happens once a day at BACKUP_AT_HOUR:00 UTC, not on container start, so
# restarting the container does not take an extra dump in the middle of the day.
#
# Environment (besides what the other scripts read):
#   BACKUP_AT_HOUR           UTC hour 0-23 to run each day (default 8, which is
#                            3 a.m. US Central during daylight saving time)
#   BACKUP_REQUIRE_OFFSITE   true: a run with no successful off-site copy
#                            (none configured, or it failed) is recorded as
#                            off-site failed, so health shows it (default false;
#                            true in the image)
#   BACKUP_VERIFY_EVERY      rehearse a restore every Nth run (default 7)
#   BACKUP_RUN_ONCE          set to 1 to run a single cycle and exit (tests,
#                            and a manual "back up now")
#   BACKUP_SCRIPT_DIR        where the sibling scripts live (default: this dir)
set -eu

AT_HOUR="${BACKUP_AT_HOUR:-8}"
VERIFY_EVERY="${BACKUP_VERIFY_EVERY:-7}"
SCRIPT_DIR="${BACKUP_SCRIPT_DIR:-$(cd "$(dirname "$0")" && pwd)}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
STATE_DIR="${BACKUP_STATE_DIR:-${BACKUP_DIR}/.status}"
export BACKUP_DIR BACKUP_STATE_DIR="${STATE_DIR}"
RUN=0
CYCLE_FAILED=0

case "${VERIFY_EVERY}" in
  "" | *[!0-9]* | 0) echo "[backup-scheduler] BACKUP_VERIFY_EVERY must be a positive integer" >&2; exit 2 ;;
esac

case "${AT_HOUR}" in
  [0-9] | [0-9][0-9]) [ "${AT_HOUR}" -le 23 ] || { echo "[backup-scheduler] BACKUP_AT_HOUR must be 0-23" >&2; exit 2; } ;;
  *) echo "[backup-scheduler] BACKUP_AT_HOUR must be 0-23" >&2; exit 2 ;;
esac

# Seconds from now until the next AT_HOUR:00:00 UTC (0 when it is exactly then).
seconds_until_run() {
  # One date call, so the three fields cannot straddle a minute boundary.
  set -- $(date -u '+%H %M %S')
  H="$(expr "$1" + 0)"
  M="$(expr "$2" + 0)"
  S="$(expr "$3" + 0)"
  SINCE=$((H * 3600 + M * 60 + S))
  echo $(((AT_HOUR * 3600 - SINCE + 86400) % 86400))
}

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
  # When off-site is required, "not configured" is as bad as "failed".
  if [ "${BACKUP_REQUIRE_OFFSITE:-false}" = "true" ] && [ "${OFFSITE}" != "true" ]; then
    OFFSITE=false
    echo "[backup-scheduler] BACKUP_REQUIRE_OFFSITE is set and no off-site copy succeeded." >&2
  fi

  record BACKUP "${OK}" "${STARTED}" "$(now)" "${DUMP_BYTES}" "${ASSETS_BYTES}" "${OFFSITE}"
  if [ "${OK}" != "true" ]; then
    echo "[backup-scheduler] backup failed; retrying at the next run." >&2
    CYCLE_FAILED=1
  fi
  if [ "${OFFSITE}" = "false" ]; then CYCLE_FAILED=1; fi

  if [ -n "${DUMP_BYTES}" ] && \
     { [ "$((RUN % VERIFY_EVERY))" -eq 1 ] || [ "${VERIFY_EVERY}" -eq 1 ]; }; then
    # A failed rehearsal must be loud but must not stop future backups.
    R_STARTED="$(now)"
    if "${SCRIPT_DIR}/pg-restore-verify.sh"; then
      record REHEARSAL true "${R_STARTED}" "$(now)"
    else
      echo "[backup-scheduler] RESTORE REHEARSAL FAILED — the backups are not proven restorable." >&2
      record REHEARSAL false "${R_STARTED}" "$(now)"
      CYCLE_FAILED=1
    fi
  fi
}

echo "[backup-scheduler] backing up daily at ${AT_HOUR}:00 UTC, rehearsing a restore every ${VERIFY_EVERY} runs"

while true; do
  if [ "${BACKUP_RUN_ONCE:-0}" != "1" ]; then
    WAIT="$(seconds_until_run)"
    echo "[backup-scheduler] next run in ${WAIT}s"
    sleep "${WAIT}"
  fi
  RUN=$((RUN + 1))
  CYCLE_FAILED=0
  run_cycle
  if [ "${BACKUP_RUN_ONCE:-0}" = "1" ]; then
    # A manual run reports failure to whoever ran it.
    exit "${CYCLE_FAILED}"
  fi
  # Step past the scheduled second so a fast run is not repeated.
  sleep 61
done
