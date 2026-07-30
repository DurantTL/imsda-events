#!/bin/sh
#
# xCloud's Dockerfile-only deployment regenerates its base Compose project and
# recreates the app without the env_file or external PostgreSQL network from
# our local override. Configure this script as the site's Deployment Script so
# the override is reapplied after every deployment.
set -eu

IMSDA_XCLOUD_RUNTIME_DIR="${IMSDA_XCLOUD_RUNTIME_DIR:-/home/u_events/.xcloud}"
IMSDA_XCLOUD_SERVICE="${IMSDA_XCLOUD_SERVICE:-app}"
IMSDA_XCLOUD_BASE_COMPOSE="${IMSDA_XCLOUD_RUNTIME_DIR}/docker-compose.yml"
IMSDA_XCLOUD_OVERRIDE_COMPOSE="${IMSDA_XCLOUD_RUNTIME_DIR}/docker-compose.env.yml"
IMSDA_XCLOUD_ENV_FILE="${IMSDA_XCLOUD_RUNTIME_DIR}/.env"

for IMSDA_REQUIRED_FILE in \
  "$IMSDA_XCLOUD_BASE_COMPOSE" \
  "$IMSDA_XCLOUD_OVERRIDE_COMPOSE" \
  "$IMSDA_XCLOUD_ENV_FILE"
do
  if [ ! -r "$IMSDA_REQUIRED_FILE" ]; then
    echo "[xcloud-post-deploy] Required runtime file is missing or unreadable: $IMSDA_REQUIRED_FILE" >&2
    exit 1
  fi
done

if ! grep -q '^DATABASE_URL=postgres\(ql\)\?://' "$IMSDA_XCLOUD_ENV_FILE"; then
  echo "[xcloud-post-deploy] DATABASE_URL is missing or malformed in $IMSDA_XCLOUD_ENV_FILE" >&2
  exit 1
fi

IMSDA_XCLOUD_RELEASE_SHA="${XCLOUD_DEPLOYED_COMMIT:-${APP_RELEASE_SHA:-}}"
IMSDA_XCLOUD_RELEASE_SHA="${IMSDA_XCLOUD_RELEASE_SHA%% *}"
if [ -n "$IMSDA_XCLOUD_RELEASE_SHA" ]; then
  if ! printf '%s\n' "$IMSDA_XCLOUD_RELEASE_SHA" | grep -Eq '^[0-9a-fA-F]{7,64}$'; then
    echo "[xcloud-post-deploy] Ignoring malformed release SHA." >&2
    IMSDA_XCLOUD_RELEASE_SHA=""
  else
    IMSDA_XCLOUD_ENV_TEMP="$(mktemp "${IMSDA_XCLOUD_RUNTIME_DIR}/.env.release.XXXXXX")"
    trap 'rm -f "$IMSDA_XCLOUD_ENV_TEMP"' EXIT
    awk -v sha="$IMSDA_XCLOUD_RELEASE_SHA" '
      BEGIN { found = 0 }
      /^APP_RELEASE_SHA=/ { print "APP_RELEASE_SHA=" sha; found = 1; next }
      { print }
      END { if (!found) print "APP_RELEASE_SHA=" sha }
    ' "$IMSDA_XCLOUD_ENV_FILE" > "$IMSDA_XCLOUD_ENV_TEMP"
    chown --reference="$IMSDA_XCLOUD_ENV_FILE" "$IMSDA_XCLOUD_ENV_TEMP"
    chmod --reference="$IMSDA_XCLOUD_ENV_FILE" "$IMSDA_XCLOUD_ENV_TEMP"
    mv "$IMSDA_XCLOUD_ENV_TEMP" "$IMSDA_XCLOUD_ENV_FILE"
    trap - EXIT
  fi
fi

echo "[xcloud-post-deploy] Validating the generated Compose project with the persistent override..."
docker compose \
  -f "$IMSDA_XCLOUD_BASE_COMPOSE" \
  -f "$IMSDA_XCLOUD_OVERRIDE_COMPOSE" \
  config --quiet

IMSDA_XCLOUD_CONTAINER_ID="$(
  docker compose \
    -f "$IMSDA_XCLOUD_BASE_COMPOSE" \
    -f "$IMSDA_XCLOUD_OVERRIDE_COMPOSE" \
    ps -q "$IMSDA_XCLOUD_SERVICE"
)"

# A timer can wake while xCloud is between removing the previous container and
# creating the replacement. Do not start a competing build; the next timer run
# will inspect the container after xCloud has finished.
if [ -z "$IMSDA_XCLOUD_CONTAINER_ID" ]; then
  echo "[xcloud-post-deploy] No app container exists yet; deferring until xCloud finishes deployment."
  exit 0
fi

IMSDA_XCLOUD_HAS_DATABASE_URL=false
if docker inspect "$IMSDA_XCLOUD_CONTAINER_ID" \
  --format '{{range .Config.Env}}{{println .}}{{end}}' |
  grep -q '^DATABASE_URL='
then
  IMSDA_XCLOUD_HAS_DATABASE_URL=true
fi

IMSDA_XCLOUD_HAS_RELEASE_SHA=true
if [ -n "$IMSDA_XCLOUD_RELEASE_SHA" ]; then
  IMSDA_XCLOUD_HAS_RELEASE_SHA=false
  if docker inspect "$IMSDA_XCLOUD_CONTAINER_ID" \
    --format '{{range .Config.Env}}{{println .}}{{end}}' |
    grep -Fxq "APP_RELEASE_SHA=$IMSDA_XCLOUD_RELEASE_SHA"
  then
    IMSDA_XCLOUD_HAS_RELEASE_SHA=true
  fi
fi

IMSDA_XCLOUD_HAS_EXPECTED_NETWORK=true
if [ -n "${IMSDA_XCLOUD_EXPECTED_NETWORK:-}" ]; then
  IMSDA_XCLOUD_HAS_EXPECTED_NETWORK=false
  if docker inspect "$IMSDA_XCLOUD_CONTAINER_ID" \
    --format '{{range $name, $settings := .NetworkSettings.Networks}}{{println $name}}{{end}}' |
    grep -Fxq "$IMSDA_XCLOUD_EXPECTED_NETWORK"
  then
    IMSDA_XCLOUD_HAS_EXPECTED_NETWORK=true
  fi
fi

if [ "$IMSDA_XCLOUD_HAS_DATABASE_URL" = true ] \
  && [ "$IMSDA_XCLOUD_HAS_EXPECTED_NETWORK" = true ] \
  && [ "$IMSDA_XCLOUD_HAS_RELEASE_SHA" = true ]
then
  echo "[xcloud-post-deploy] Runtime override is already present; no container change needed."
  exit 0
fi

echo "[xcloud-post-deploy] Recreating $IMSDA_XCLOUD_SERVICE with its runtime environment and database network..."
docker compose \
  -f "$IMSDA_XCLOUD_BASE_COMPOSE" \
  -f "$IMSDA_XCLOUD_OVERRIDE_COMPOSE" \
  up -d --force-recreate "$IMSDA_XCLOUD_SERVICE"

IMSDA_XCLOUD_CONTAINER_ID="$(
  docker compose \
    -f "$IMSDA_XCLOUD_BASE_COMPOSE" \
    -f "$IMSDA_XCLOUD_OVERRIDE_COMPOSE" \
    ps -q "$IMSDA_XCLOUD_SERVICE"
)"

if [ -z "$IMSDA_XCLOUD_CONTAINER_ID" ]; then
  echo "[xcloud-post-deploy] Compose did not return a container for $IMSDA_XCLOUD_SERVICE." >&2
  exit 1
fi

if ! docker inspect "$IMSDA_XCLOUD_CONTAINER_ID" \
  --format '{{range .Config.Env}}{{println .}}{{end}}' |
  grep -q '^DATABASE_URL='
then
  echo "[xcloud-post-deploy] The recreated container is still missing DATABASE_URL." >&2
  exit 1
fi

if [ -n "${IMSDA_XCLOUD_EXPECTED_NETWORK:-}" ]; then
  if ! docker inspect "$IMSDA_XCLOUD_CONTAINER_ID" \
    --format '{{range $name, $settings := .NetworkSettings.Networks}}{{println $name}}{{end}}' |
    grep -Fxq "$IMSDA_XCLOUD_EXPECTED_NETWORK"
  then
    echo "[xcloud-post-deploy] The recreated container is missing network $IMSDA_XCLOUD_EXPECTED_NETWORK." >&2
    exit 1
  fi
fi

echo "[xcloud-post-deploy] Runtime override restored successfully."
