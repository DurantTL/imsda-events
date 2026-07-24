#!/bin/sh
# Container entrypoint: bring the schema up to date, then run the app.
# `depends_on: condition: service_healthy` in docker-compose ensures Postgres is
# accepting connections before this runs.
#
# There is deliberately no seed step. `prisma/seed.ts` writes fictitious events,
# people, registrations, payments and a refund, and gives every account one
# shared password — it refuses to run outside a local database. The supported
# way to reach a first real administrator is:
#
#   docker compose exec app npm run admin:create -- --email you@imsda.org --name "Your Name"
set -e

echo "[entrypoint] Applying database migrations (prisma migrate deploy)..."
npx prisma migrate deploy

if [ "${RUN_DB_SEED}" = "true" ]; then
  echo "[entrypoint] RUN_DB_SEED is no longer supported. Fictitious demo data is local-only;" >&2
  echo "[entrypoint] use 'npm run admin:create' to create a real administrator." >&2
  exit 1
fi

echo "[entrypoint] Starting: $*"
exec "$@"
