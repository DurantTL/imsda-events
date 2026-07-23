#!/bin/sh
# Container entrypoint: bring the schema up to date, optionally seed, then run the
# app. `depends_on: condition: service_healthy` in docker-compose ensures Postgres
# is accepting connections before this runs.
set -e

echo "[entrypoint] Applying database migrations (prisma migrate deploy)..."
npx prisma migrate deploy

if [ "${RUN_DB_SEED}" = "true" ]; then
  echo "[entrypoint] RUN_DB_SEED=true -> seeding fictitious starter data (prisma db seed)..."
  npx prisma db seed
fi

echo "[entrypoint] Starting: $*"
exec "$@"
