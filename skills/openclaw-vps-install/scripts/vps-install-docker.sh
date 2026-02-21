#!/usr/bin/env bash
set -euo pipefail

# Install OpenClaw via Docker on a prepared VPS: install Docker, clone repo,
# write .env, build image, create systemd wrapper, start service.

usage() {
  echo "Usage: $0 root@TARGET_HOST openclaw@TARGET_HOST [GATEWAY_TOKEN]"
  echo ""
  echo "  root@TARGET_HOST     Root SSH target for system-level ops"
  echo "  openclaw@TARGET_HOST openclaw SSH target for app-level ops"
  echo "  GATEWAY_TOKEN        32-char hex token (auto-generated if omitted)"
  echo ""
  echo "Example: $0 root@1.2.3.4 openclaw@1.2.3.4"
  exit 1
}

[[ $# -lt 2 ]] && usage

ROOT_TARGET="$1"
OC_TARGET="$2"
TOKEN="${3:-$(openssl rand -hex 32)}"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)

log()  { echo "[$(date +%H:%M:%S)] $*"; }
check() { log "[CHECKING] $*"; }
done_() { log "[DONE]     $*"; }
skip()  { log "[SKIP]     $*"; }
warn()  { log "[WARN]     $*"; }

check "Docker engine"
ssh "${SSH_OPTS[@]}" "$ROOT_TARGET" bash -s <<'REMOTE'
if docker --version &>/dev/null; then
  echo "[SKIP]     Docker already installed: $(docker --version)"
else
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
  echo "[DONE]     Docker installed"
fi
REMOTE

check "openclaw in docker group"
ssh "${SSH_OPTS[@]}" "$ROOT_TARGET" bash -s <<'REMOTE'
if id -nG openclaw | grep -qw docker; then
  echo "[SKIP]     openclaw already in docker group"
else
  usermod -aG docker openclaw
  echo "[DONE]     openclaw added to docker group"
fi
REMOTE

check "OpenClaw repo"
ssh "${SSH_OPTS[@]}" "$OC_TARGET" bash -s <<'REMOTE'
if [[ -d ~/openclaw/.git ]]; then
  cd ~/openclaw && git pull --ff-only
  echo "[SKIP]     repo already cloned (pulled latest)"
else
  git clone https://github.com/openclaw/openclaw.git ~/openclaw
  echo "[DONE]     repo cloned"
fi
REMOTE

check ".env file"
ssh "${SSH_OPTS[@]}" "$OC_TARGET" bash -s -- "$TOKEN" <<'REMOTE'
TOKEN="$1"
ENV_FILE=~/openclaw/.env
if [[ -f "$ENV_FILE" ]]; then
  echo "[SKIP]     .env already exists"
else
  cat > "$ENV_FILE" <<ENV
OPENCLAW_IMAGE=openclaw:local
OPENCLAW_GATEWAY_TOKEN=$TOKEN
OPENCLAW_GATEWAY_BIND=loopback
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_CONFIG_DIR=/home/openclaw/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/openclaw/.openclaw/workspace
ENV
  chmod 600 "$ENV_FILE"
  echo "[DONE]     .env written"
fi
REMOTE

check "Docker image build"
ssh "${SSH_OPTS[@]}" "$OC_TARGET" bash -s <<'REMOTE'
cd ~/openclaw
docker compose build 2>&1 | tail -5
echo "[DONE]     image built"
REMOTE

check "Systemd service for docker compose"
ssh "${SSH_OPTS[@]}" "$ROOT_TARGET" bash -s <<'REMOTE'
SERVICE_FILE="/etc/systemd/system/openclaw-docker.service"
if [[ -f "$SERVICE_FILE" ]]; then
  echo "[SKIP]     systemd service file exists"
else
  cat > "$SERVICE_FILE" <<'SVC'
[Unit]
Description=OpenClaw Gateway (Docker)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
User=openclaw
WorkingDirectory=/home/openclaw/openclaw
EnvironmentFile=/home/openclaw/openclaw/.env
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose stop
ExecReload=/usr/bin/docker compose pull && /usr/bin/docker compose up -d
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
SVC
  echo "[DONE]     service file created"
fi
systemctl daemon-reload
systemctl enable openclaw-docker.service
systemctl start openclaw-docker.service || true
sleep 5
if systemctl is-active openclaw-docker.service &>/dev/null; then
  echo "[DONE]     docker service is running"
else
  echo "[WARN]     service not active — check: systemctl status openclaw-docker.service"
fi
REMOTE

echo ""
log "[DONE]     Docker install complete"
echo "========================================="
echo "GATEWAY_TOKEN: $TOKEN"
echo "========================================="
echo "Save this token — you need it for SSH tunnel access."
