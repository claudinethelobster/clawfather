#!/usr/bin/env bash
set -euo pipefail

# Install OpenClaw natively on a prepared VPS: run installer, write secure config,
# set up logging, install systemd service, enable lingering, start gateway.

usage() {
  echo "Usage: $0 openclaw@TARGET_HOST [GATEWAY_TOKEN]"
  echo ""
  echo "  TARGET_HOST    VPS IP or hostname"
  echo "  GATEWAY_TOKEN  32-char hex token (auto-generated if omitted)"
  echo ""
  echo "Example: $0 openclaw@1.2.3.4"
  exit 1
}

[[ $# -lt 1 ]] && usage

TARGET="$1"
TOKEN="${2:-$(openssl rand -hex 32)}"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)

log()  { echo "[$(date +%H:%M:%S)] $*"; }
check() { log "[CHECKING] $*"; }
done_() { log "[DONE]     $*"; }
skip()  { log "[SKIP]     $*"; }
warn()  { log "[WARN]     $*"; }

check "OpenClaw binary"
ssh "${SSH_OPTS[@]}" "$TARGET" bash -s <<'REMOTE'
export PATH=$(npm prefix -g 2>/dev/null)/bin:$PATH
if command -v openclaw &>/dev/null; then
  echo "[SKIP]     openclaw already installed: $(openclaw --version)"
else
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
  echo "[DONE]     openclaw installed"
fi
REMOTE

check "Secure config"
ssh "${SSH_OPTS[@]}" "$TARGET" bash -s -- "$TOKEN" <<'REMOTE'
TOKEN="$1"
mkdir -p ~/.openclaw
if [[ -f ~/.openclaw/openclaw.json ]]; then
  echo "[SKIP]     openclaw.json already exists"
else
  cat > ~/.openclaw/openclaw.json <<CONF
{
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "port": 18789,
    "auth": { "mode": "token", "token": "$TOKEN" }
  },
  "session": { "dmScope": "per-channel-peer" },
  "tools": {
    "deny": ["gateway", "cron", "sessions_spawn", "sessions_send"],
    "exec": { "security": "ask", "ask": "always" },
    "elevated": { "enabled": false },
    "fs": { "workspaceOnly": true }
  },
  "discovery": { "mdns": { "mode": "off" } },
  "logging": {
    "file": "/var/log/openclaw/openclaw.log",
    "level": "info",
    "redactSensitive": "tools"
  }
}
CONF
  echo "[DONE]     config written"
fi
chmod 700 ~/.openclaw
chmod 600 ~/.openclaw/openclaw.json
REMOTE

check "Log directory"
ssh "${SSH_OPTS[@]}" "$TARGET" bash -s <<'REMOTE'
if [[ -d /var/log/openclaw ]]; then
  echo "[SKIP]     /var/log/openclaw exists"
else
  sudo mkdir -p /var/log/openclaw
  sudo chown openclaw:openclaw /var/log/openclaw
  echo "[DONE]     log directory created"
fi
REMOTE

check "Systemd service install"
ssh "${SSH_OPTS[@]}" "$TARGET" bash -s <<'REMOTE'
export PATH=$(npm prefix -g 2>/dev/null)/bin:$PATH
if systemctl --user cat openclaw-gateway &>/dev/null; then
  echo "[SKIP]     service already installed"
else
  openclaw gateway install
  echo "[DONE]     service installed"
fi
REMOTE

check "Lingering"
HOST="${TARGET#*@}"
ssh "${SSH_OPTS[@]}" "root@${HOST}" "loginctl enable-linger openclaw"
done_ "Lingering enabled"

check "Service start"
ssh "${SSH_OPTS[@]}" "$TARGET" bash -s <<'REMOTE'
systemctl --user daemon-reload
systemctl --user enable openclaw-gateway
systemctl --user start openclaw-gateway || true
sleep 3
if systemctl --user is-active openclaw-gateway &>/dev/null; then
  echo "[DONE]     service is running"
else
  echo "[WARN]     service not active — check: journalctl --user -u openclaw-gateway -n 30"
fi
REMOTE

echo ""
log "[DONE]     Native install complete"
echo "========================================="
echo "GATEWAY_TOKEN: $TOKEN"
echo "========================================="
echo "Save this token — you need it for SSH tunnel access."
