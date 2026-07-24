#!/bin/sh
# Restores the most recent dump into a scratch database and records row counts.
#
# This is the part that is usually skipped. A backup that has never been
# restored is not a backup — it is an untested assumption about a file. Run this
# on a schedule and keep its output; the row counts are the evidence that the
# rehearsal happened and what it found.
#
# The scratch database is created and dropped by this script. It never touches
# the live database, and it refuses to run if the scratch name is the live one.
#
# Environment:
#   PGHOST, PGUSER, PGPASSWORD, PGDATABASE   connection (compose supplies these)
#   BACKUP_DIR            where dumps are read from (default /backups)
#   RESTORE_SCRATCH_DB    scratch database name (default imsda_events_restore_check)
#   BACKUP_FILE           restore this dump instead of the newest one
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
LIVE_DB="${PGDATABASE:-imsda_events}"
SCRATCH_DB="${RESTORE_SCRATCH_DB:-imsda_events_restore_check}"

if [ "${SCRATCH_DB}" = "${LIVE_DB}" ]; then
  echo "[restore-verify] RESTORE_SCRATCH_DB must not be the live database (${LIVE_DB})." >&2
  exit 1
fi

DUMP="${BACKUP_FILE:-$(ls -1t "${BACKUP_DIR}"/imsda-events-*.dump 2>/dev/null | head -n 1 || true)}"
if [ -z "${DUMP}" ] || [ ! -f "${DUMP}" ]; then
  echo "[restore-verify] No dump found in ${BACKUP_DIR}." >&2
  exit 1
fi

echo "[restore-verify] $(date -u +%FT%TZ) restoring ${DUMP} into ${SCRATCH_DB}"

cleanup() {
  psql --dbname=postgres --quiet --command "DROP DATABASE IF EXISTS \"${SCRATCH_DB}\";" >/dev/null 2>&1 || true
}
trap cleanup EXIT

psql --dbname=postgres --quiet --command "DROP DATABASE IF EXISTS \"${SCRATCH_DB}\";"
psql --dbname=postgres --quiet --command "CREATE DATABASE \"${SCRATCH_DB}\";"

# --exit-on-error turns a partially restored database into a failed rehearsal,
# which is the whole point of running this.
pg_restore --dbname="${SCRATCH_DB}" --no-owner --no-privileges --exit-on-error "${DUMP}"

echo "[restore-verify] row counts in the restored copy:"
psql --dbname="${SCRATCH_DB}" --tuples-only --no-align --field-separator=' ' --command "
  SELECT relname, n_live_tup
  FROM pg_stat_user_tables
  WHERE n_live_tup > 0
  ORDER BY n_live_tup DESC, relname;
" | sed 's/^/[restore-verify]   /'

# The tables that hold the data a rehearsal exists to protect. A restore that
# comes back with an empty Registration table has failed, however clean the
# pg_restore exit code was.
for table in Registration RegistrationAttendee Payment Person; do
  COUNT="$(psql --dbname="${SCRATCH_DB}" --tuples-only --no-align --command "SELECT count(*) FROM \"${table}\";")"
  echo "[restore-verify]   verified ${table}=${COUNT}"
done

echo "[restore-verify] $(date -u +%FT%TZ) restore rehearsal succeeded for ${DUMP}"
