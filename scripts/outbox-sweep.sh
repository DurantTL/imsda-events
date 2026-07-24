#!/bin/sh
# Scheduled caller for the message outbox.
#
# A message that fails its first delivery attempt is rescheduled with backoff,
# and a message stranded by a container restart keeps a stale lock. Neither
# recovers on its own — until this ran, the only thing that swept the queue was
# a staff member opening Communications and clicking a button.
#
# Runs as its own tiny container in docker-compose.yml. At this scale a loop
# with a sleep is sufficient; no queue infrastructure is needed.
set -eu

SWEEP_URL="${OUTBOX_SWEEP_URL:-http://app:3000/api/internal/outbox/sweep}"
INTERVAL_SECONDS="${OUTBOX_SWEEP_INTERVAL_SECONDS:-300}"

if [ -z "${OUTBOX_SWEEP_TOKEN:-}" ]; then
  echo "[outbox-sweep] OUTBOX_SWEEP_TOKEN is not set; refusing to start." >&2
  exit 1
fi

echo "[outbox-sweep] Sweeping ${SWEEP_URL} every ${INTERVAL_SECONDS}s."

while true; do
  # A failed sweep must never take the container down — the next tick retries.
  response="$(
    curl --silent --show-error --max-time 120 \
      --write-out '\n%{http_code}' \
      --request POST \
      --header "Authorization: Bearer ${OUTBOX_SWEEP_TOKEN}" \
      "${SWEEP_URL}" 2>&1
  )" || response="request failed"

  status="$(printf '%s' "${response}" | tail -n 1)"
  body="$(printf '%s' "${response}" | sed '$d')"

  if [ "${status}" = "200" ]; then
    echo "[outbox-sweep] $(date -u +%FT%TZ) ${body}"
  else
    echo "[outbox-sweep] $(date -u +%FT%TZ) sweep failed (status=${status}): ${body}" >&2
  fi

  sleep "${INTERVAL_SECONDS}"
done
