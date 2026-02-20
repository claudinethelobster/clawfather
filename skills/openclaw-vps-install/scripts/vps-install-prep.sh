#!/usr/bin/env bash
set -euo pipefail

# Prepare a VPS for OpenClaw: update packages, install deps, create openclaw user,
# copy SSH keys, and configure passwordless sudo for service management.

usage() {
  echo "Usage: $0 TARGET_USER@TARGET_HOST"
  echo ""
  echo "  TARGET_USER  SSH user with root/sudo access (usually root)"
  echo "  TARGET_HOST  VPS IP or hostname"
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

check "System update"
ssh "${SSH_OPTS[@]}" "$TARGET" "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq"
done_ "System update"

check "Base dependencies (curl git ca-certificates ufw fail2ban)"
ssh "${SSH_OPTS[@]}" "$TARGET" "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl git ca-certificates ufw fail2ban"
done_ "Base dependencies"

check "openclaw user"
ssh "${SSH_OPTS[@]}" "$TARGET" bash -s <<'REMOTE'
if id openclaw &>/dev/null; then
  echo "[SKIP]     openclaw user already exists"
else
  useradd -m -s /bin/bash -d /home/openclaw openclaw
  echo "[DONE]     openclaw user created"
fi
REMOTE

check "SSH authorized_keys for openclaw"
ssh "${SSH_OPTS[@]}" "$TARGET" bash -s <<'REMOTE'
mkdir -p /home/openclaw/.ssh
if [[ -f /home/openclaw/.ssh/authorized_keys ]] && [[ -s /home/openclaw/.ssh/authorized_keys ]]; then
  echo "[SKIP]     authorized_keys already present"
else
  cp /root/.ssh/authorized_keys /home/openclaw/.ssh/authorized_keys 2>/dev/null || true
  echo "[DONE]     copied authorized_keys"
fi
chown -R openclaw:openclaw /home/openclaw/.ssh
chmod 700 /home/openclaw/.ssh
chmod 600 /home/openclaw/.ssh/authorized_keys
REMOTE
done_ "SSH key setup"

check "sudoers drop-in for openclaw"
ssh "${SSH_OPTS[@]}" "$TARGET" bash -s <<'REMOTE'
SUDOERS_FILE="/etc/sudoers.d/openclaw"
if [[ -f "$SUDOERS_FILE" ]]; then
  echo "[SKIP]     sudoers drop-in already exists"
else
  cat > "$SUDOERS_FILE" <<'SUDOERS'
# Passwordless sudo for openclaw service management
openclaw ALL=(ALL) NOPASSWD: /bin/systemctl daemon-reload
openclaw ALL=(ALL) NOPASSWD: /usr/bin/loginctl enable-linger openclaw
openclaw ALL=(ALL) NOPASSWD: /bin/mkdir -p /var/log/openclaw
openclaw ALL=(ALL) NOPASSWD: /bin/chown openclaw\:openclaw /var/log/openclaw
SUDOERS
  chmod 0440 "$SUDOERS_FILE"
  visudo -cf "$SUDOERS_FILE" || { rm -f "$SUDOERS_FILE"; echo "[FAIL]     sudoers syntax error"; exit 1; }
  echo "[DONE]     sudoers drop-in created"
fi
REMOTE

log "[DONE]     VPS preparation complete"
