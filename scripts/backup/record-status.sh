#!/bin/sh
# Writes one BackupRun status row for /api/health to read.
#
#   record-status.sh KIND OK STARTED FINISHED [DUMP_BYTES] [ASSETS_BYTES] [OFFSITE_OK]
#
#   KIND         BACKUP or REHEARSAL
#   OK           true or false
#   STARTED, FINISHED  UTC timestamps, e.g. 2026-10-12T03:00:00Z
#   DUMP_BYTES, ASSETS_BYTES  integers, or empty
#   OFFSITE_OK   true, false, or empty (no off-site copy configured)
#
# Only times, sizes and flags are stored: no file names, paths, row contents or
# credentials. Connects with the standard PG* variables the other scripts use.
# Values are validated here and passed to psql as variables, never spliced into
# the SQL text.
set -eu

if [ "$#" -lt 4 ]; then
  echo "usage: record-status.sh KIND OK STARTED FINISHED [DUMP_BYTES] [ASSETS_BYTES] [OFFSITE_OK]" >&2
  exit 2
fi

KIND="$1"
OK="$2"
STARTED="$3"
FINISHED="$4"
DUMP_BYTES="${5:-}"
ASSETS_BYTES="${6:-}"
OFFSITE_OK="${7:-}"

case "${KIND}" in BACKUP | REHEARSAL) ;; *) echo "[record-status] bad kind" >&2; exit 2 ;; esac
case "${OK}" in true | false) ;; *) echo "[record-status] bad ok flag" >&2; exit 2 ;; esac
case "${OFFSITE_OK}" in true | false | "") ;; *) echo "[record-status] bad off-site flag" >&2; exit 2 ;; esac
case "${DUMP_BYTES}" in *[!0-9]*) echo "[record-status] bad dump size" >&2; exit 2 ;; esac
case "${ASSETS_BYTES}" in *[!0-9]*) echo "[record-status] bad assets size" >&2; exit 2 ;; esac
for stamp in "${STARTED}" "${FINISHED}"; do
  case "${stamp}" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;;
    *) echo "[record-status] bad timestamp" >&2; exit 2 ;;
  esac
done

psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 \
  --set "kind=${KIND}" --set "ok=${OK}" \
  --set "started=${STARTED}" --set "finished=${FINISHED}" \
  --set "dump=${DUMP_BYTES}" --set "assets=${ASSETS_BYTES}" \
  --set "offsite=${OFFSITE_OK}" <<'SQL' >/dev/null
INSERT INTO "BackupRun" ("kind", "startedAt", "finishedAt", "ok", "dumpBytes", "assetsBytes", "offsiteOk")
VALUES (
  :'kind',
  :'started'::timestamp,
  :'finished'::timestamp,
  :'ok'::boolean,
  NULLIF(:'dump', '')::bigint,
  NULLIF(:'assets', '')::bigint,
  NULLIF(:'offsite', '')::boolean
);
SQL

echo "[record-status] recorded ${KIND} ok=${OK}"
