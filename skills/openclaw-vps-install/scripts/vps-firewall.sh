#!/usr/bin/env bash
set -euo pipefail

# Configure UFW firewall (deny all except SSH) and enable fail2ban.

usage() {
  echo "Usage: $0 root@TARGET_HOST"
  echo ""
  echo "Example: $0 root@1.2.3.4"
  exit 1
}

[[ $# -lt 1 ]] && usage

TARGET="$1"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)

log()  { echo "[$(date +%H:%M:%S)] $*"; }
check() { log "[CHECKING] $*"; }
done_() { log "[DONE]     $*"; }
skip()  { log "[SKIP]     $*"; }

check "UFW firewall"
ssh "${SSH_OPTS[@]}" "$TARGET" bash -s <<'REMOTE'
if ufw status | grep -q "Status: active"; then
  RULES=$(ufw status | grep -c ALLOW || true)
  if [[ "$RULES" -le 2 ]] && ufw status | grep -q "22/tcp"; then
    echo "[SKIP]     UFW active with SSH-only rules"
    ufw status verbose
    exit 0
  fi
fi

ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh comment 'SSH access'
echo 'y' | ufw enable
ufw status verbose
echo "[DONE]     UFW configured"
REMOTE

check "fail2ban"
ssh "${SSH_OPTS[@]}" "$TARGET" bash -s <<'REMOTE'
if systemctl is-active fail2ban &>/dev/null; then
  echo "[SKIP]     fail2ban already running"
else
  systemctl enable fail2ban
  systemctl start fail2ban
  echo "[DONE]     fail2ban enabled and started"
fi
fail2ban-client status 2>/dev/null || true
REMOTE

done_ "Firewall setup complete"
