#!/usr/bin/env bash
set -euo pipefail

SERVER_URL="${SERVER_URL:-__DEFAULT_SERVER_URL__}"
DEVICE_ID="${DEVICE_ID:-$(hostname)}"
DEVICE_HOSTNAME="${DEVICE_HOSTNAME:-$(hostname)}"
SCANNER_DEVICE="${SCANNER_DEVICE:-}"
SCANNER_NAME_MATCH="${SCANNER_NAME_MATCH:-}"
INSTALL_DIR="/opt/production-suite-scanner"
CLIENT_PATH="${INSTALL_DIR}/scanner-client.py"
ENV_PATH="/etc/production-suite-scanner.env"
SERVICE_PATH="/etc/systemd/system/production-suite-scanner.service"
SERVICE_NAME="production-suite-scanner"

echo "[install] Production scanner Pi installer"
echo "[install] Server URL: ${SERVER_URL}"
echo "[install] Device ID: ${DEVICE_ID}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "[install] Installing python3"
  apt-get update
  apt-get install -y python3
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "[install] Installing curl"
  apt-get update
  apt-get install -y curl
fi

if ! python3 -c "import evdev" >/dev/null 2>&1; then
  echo "[install] Installing python3-evdev"
  apt-get update
  apt-get install -y python3-evdev
fi

install -d -m 0755 "${INSTALL_DIR}"
curl -fsSL "${SERVER_URL}/pi/scanner-client.py" -o "${CLIENT_PATH}"
chmod 0755 "${CLIENT_PATH}"

cat > "${ENV_PATH}" <<EOF
SERVER_URL=${SERVER_URL}
DEVICE_ID=${DEVICE_ID}
DEVICE_HOSTNAME=${DEVICE_HOSTNAME}
SCANNER_DEVICE=${SCANNER_DEVICE}
SCANNER_NAME_MATCH=${SCANNER_NAME_MATCH}
EOF
chmod 0600 "${ENV_PATH}"

cat > "${SERVICE_PATH}" <<EOF
[Unit]
Description=Production scanner client
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${ENV_PATH}
ExecStart=/usr/bin/python3 ${CLIENT_PATH}
Restart=always
RestartSec=2
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"

echo
echo "[install] Done."
echo "[install] Check status:  sudo systemctl status ${SERVICE_NAME} --no-pager"
echo "[install] Live logs:      sudo journalctl -u ${SERVICE_NAME} -f"
echo "[install] Config file:    ${ENV_PATH}"
if [[ -z "${SCANNER_DEVICE}" && -z "${SCANNER_NAME_MATCH}" ]]; then
  echo "[install] If the wrong input device is picked, set SCANNER_DEVICE or SCANNER_NAME_MATCH in ${ENV_PATH} and restart the service."
fi
