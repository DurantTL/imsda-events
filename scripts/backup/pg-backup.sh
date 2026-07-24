#!/bin/sh
# Nightly logical backup of the events database.
#
# Once the production database is authoritative for registrations and payments,
# an unbacked-up volume is the largest single risk in the deployment. This runs
# as its own container in docker-compose.yml against the same internal network.
#
# Format is pg_dump's custom format (-Fc): compressed, and restorable with
# pg_restore into an empty database, which is what pg-restore-verify.sh does.
#
# Environment:
#   PGHOST, PGUSER, PGPASSWORD, PGDATABASE   connection (compose supplies these)
#   BACKUP_DIR             where dumps are written (default /backups)
#   BACKUP_RETENTION_DAYS  dumps older than this are deleted (default 14)
#   BACKUP_OFFSITE_COMMAND optional shell command run with the dump path as $1
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="${BACKUP_DIR}/imsda-events-${STAMP}.dump"

mkdir -p "${BACKUP_DIR}"

echo "[backup] $(date -u +%FT%TZ) dumping ${PGDATABASE:-imsda_events} to ${TARGET}"

# Write to a temporary name first so a crash never leaves a truncated file that
# looks like a usable backup.
pg_dump --format=custom --compress=6 --file="${TARGET}.partial"
mv "${TARGET}.partial" "${TARGET}"

SIZE="$(wc -c < "${TARGET}")"
if [ "${SIZE}" -lt 1024 ]; then
  echo "[backup] Refusing to keep a ${SIZE}-byte dump; something is wrong." >&2
  rm -f "${TARGET}"
  exit 1
fi

echo "[backup] wrote ${SIZE} bytes to ${TARGET}"

if [ -n "${BACKUP_OFFSITE_COMMAND:-}" ]; then
  # A backup that only exists on the same host as the database is not a backup.
  echo "[backup] copying off-host"
  sh -c "${BACKUP_OFFSITE_COMMAND}" _ "${TARGET}"
fi

echo "[backup] pruning dumps older than ${RETENTION_DAYS} days"
find "${BACKUP_DIR}" -name 'imsda-events-*.dump' -type f -mtime "+${RETENTION_DAYS}" -print -delete

echo "[backup] $(date -u +%FT%TZ) complete"
