#!/bin/sh
#
# Installs the xCloud runtime repair hook as a small systemd timer. The timer is
# independent of xCloud's Deployment Script field, which is not executed by
# every Dockerfile-only site type.
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root." >&2
  exit 1
fi

IMSDA_GUARD_SOURCE_URL="${IMSDA_GUARD_SOURCE_URL:-https://raw.githubusercontent.com/DurantTL/imsda-events/main/scripts/xcloud-post-deploy.sh}"
IMSDA_GUARD_EXECUTABLE="/usr/local/sbin/imsda-xcloud-runtime-guard"
IMSDA_GUARD_ENV_FILE="/etc/default/imsda-xcloud-runtime-guard"
IMSDA_GUARD_SERVICE_FILE="/etc/systemd/system/imsda-xcloud-runtime-guard.service"
IMSDA_GUARD_TIMER_FILE="/etc/systemd/system/imsda-xcloud-runtime-guard.timer"

IMSDA_GUARD_TEMP_FILE="$(mktemp)"
trap 'rm -f "$IMSDA_GUARD_TEMP_FILE"' EXIT

curl --fail --silent --show-error --location \
  "$IMSDA_GUARD_SOURCE_URL" \
  --output "$IMSDA_GUARD_TEMP_FILE"
sh -n "$IMSDA_GUARD_TEMP_FILE"
install -m 0755 "$IMSDA_GUARD_TEMP_FILE" "$IMSDA_GUARD_EXECUTABLE"

if [ ! -e "$IMSDA_GUARD_ENV_FILE" ]; then
  umask 077
  {
    echo 'IMSDA_XCLOUD_RUNTIME_DIR=/home/u_events/.xcloud'
    echo 'IMSDA_XCLOUD_SERVICE=app'
    echo 'IMSDA_XCLOUD_EXPECTED_NETWORK=postgresql_9kgaw_239292_xcloud-network'
  } > "$IMSDA_GUARD_ENV_FILE"
fi

{
  echo '[Unit]'
  echo 'Description=Restore IMSDA Events xCloud runtime override'
  echo 'After=docker.service network-online.target'
  echo 'Requires=docker.service'
  echo
  echo '[Service]'
  echo 'Type=oneshot'
  echo 'EnvironmentFile=/etc/default/imsda-xcloud-runtime-guard'
  echo "ExecStart=$IMSDA_GUARD_EXECUTABLE"
} > "$IMSDA_GUARD_SERVICE_FILE"

{
  echo '[Unit]'
  echo 'Description=Continuously verify the IMSDA Events xCloud runtime override'
  echo
  echo '[Timer]'
  echo 'OnBootSec=15s'
  echo 'OnUnitActiveSec=30s'
  echo 'AccuracySec=5s'
  echo 'Persistent=true'
  echo 'Unit=imsda-xcloud-runtime-guard.service'
  echo
  echo '[Install]'
  echo 'WantedBy=timers.target'
} > "$IMSDA_GUARD_TIMER_FILE"

systemctl daemon-reload
systemctl enable --now imsda-xcloud-runtime-guard.timer
systemctl start imsda-xcloud-runtime-guard.service

echo
echo "Installed the IMSDA xCloud runtime guard."
echo "Status: systemctl status imsda-xcloud-runtime-guard.timer --no-pager"
echo "Logs:   journalctl -u imsda-xcloud-runtime-guard.service -n 50 --no-pager"
