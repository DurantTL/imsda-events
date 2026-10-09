#!/bin/sh
# Archives uploaded event files alongside the database backup.
#
# The database stores metadata for flyers, schedules, and images, but their
# bytes live in the imsda_events_assets volume. Backing up only PostgreSQL would
# restore rows that point to files which no longer exist after a server loss.
set -eu

ASSET_DIR="${ASSET_DIR:-/assets}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="${BACKUP_DIR}/imsda-assets-${STAMP}.tar.gz"

STATE_DIR="${BACKUP_STATE_DIR:-${BACKUP_DIR}/.status}"

# The assets volume is mounted read-only in production; mkdir -p is a no-op
# there and only matters for a fresh local directory.
mkdir -p "${ASSET_DIR}" "${BACKUP_DIR}" "${STATE_DIR}"
rm -f "${STATE_DIR}/assets.state"

echo "[asset-backup] $(date -u +%FT%TZ) archiving ${ASSET_DIR} to ${TARGET}"
tar -czf "${TARGET}.partial" -C "${ASSET_DIR}" .

# Prove the archive can at least be read before giving it its final name.
tar -tzf "${TARGET}.partial" >/dev/null
mv "${TARGET}.partial" "${TARGET}"

SIZE="$(wc -c < "${TARGET}")"
echo "[asset-backup] wrote ${SIZE} bytes to ${TARGET}"

printf 'BYTES=%s\n' "${SIZE}" > "${STATE_DIR}/assets.state"

OFFSITE_FAILED=0
if [ -n "${BACKUP_OFFSITE_COMMAND:-}" ]; then
  echo "[asset-backup] copying off-host"
  if sh -c "${BACKUP_OFFSITE_COMMAND}" _ "${TARGET}"; then
    echo "OFFSITE=ok" >> "${STATE_DIR}/assets.state"
  else
    echo "[asset-backup] OFF-SITE COPY FAILED; the archive exists only on this host." >&2
    echo "OFFSITE=failed" >> "${STATE_DIR}/assets.state"
    OFFSITE_FAILED=1
  fi
else
  echo "OFFSITE=skipped" >> "${STATE_DIR}/assets.state"
fi

echo "[asset-backup] pruning archives older than ${RETENTION_DAYS} days"
find "${BACKUP_DIR}" -name 'imsda-assets-*.tar.gz' -type f \
  -mtime "+${RETENTION_DAYS}" -print -delete

if [ "${OFFSITE_FAILED}" -ne 0 ]; then
  exit 1
fi

echo "[asset-backup] $(date -u +%FT%TZ) complete"
