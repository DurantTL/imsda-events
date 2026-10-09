#!/bin/sh
# Copies one backup file to Cloudflare R2 over its S3-compatible API.
#
#   offsite-r2.sh /backups/imsda-events-<stamp>.dump
#
# This is what BACKUP_OFFSITE_COMMAND runs. Credentials come only from the
# environment (the server's env file); nothing is read from, or written to, the
# repository or the image, and nothing here prints them.
#
# Environment (all required):
#   R2_ACCOUNT_ID         Cloudflare account id (forms the endpoint hostname)
#   R2_ACCESS_KEY_ID      access key id of a bucket-scoped R2 API token
#   R2_SECRET_ACCESS_KEY  secret for that token
#   R2_BUCKET             bucket name
# Optional:
#   R2_PREFIX             key prefix inside the bucket (default imsda-events)
set -eu

FILE="${1:-}"
if [ -z "${FILE}" ] || [ ! -f "${FILE}" ]; then
  echo "[offsite-r2] usage: offsite-r2.sh <file>" >&2
  exit 2
fi

for name in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
  eval "value=\${${name}:-}"
  if [ -z "${value}" ]; then
    echo "[offsite-r2] ${name} is not set; cannot copy off-site." >&2
    exit 1
  fi
done

PREFIX="${R2_PREFIX:-imsda-events}"
KEY="${PREFIX}/$(basename "${FILE}")"

AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}"
AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}"
# R2 ignores the region but the CLI wants one. Newer CLI versions add checksum
# headers R2 only partly supports unless told otherwise.
AWS_DEFAULT_REGION=auto
AWS_REQUEST_CHECKSUM_CALCULATION=when_required
AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION \
  AWS_REQUEST_CHECKSUM_CALCULATION AWS_RESPONSE_CHECKSUM_VALIDATION

echo "[offsite-r2] uploading $(basename "${FILE}") to bucket ${R2_BUCKET} under ${PREFIX}/"
aws s3 cp "${FILE}" "s3://${R2_BUCKET}/${KEY}" \
  --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --only-show-errors
echo "[offsite-r2] uploaded ${KEY}"
