#!/usr/bin/env bash
set -euo pipefail

# Apply security hardening: UFW, fail2ban, file permissions, loopback bind,
# mdns off, dmScope, elevated tools, SSH hardening, systemd hardening.

usage() {
  echo "Usage: $0 root@TARGET_HOST openclaw@TARGET_HOST"
  echo ""
  echo "Example: $0 root@1.2.3.4 openclaw@1.2.3.4"
  exit 1
}

[[ $# -lt 2 ]] && usage

ROOT_TARGET="$1"
OC_TARGET="$2"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)

log()  { echo "[$(date +%H:%M:%S)] $*"; }
check() { log "[CHECKING] $*"; }
done_() { log "[DONE]     $*"; }
skip()  { log "[SKIP]     $*"; }
warn()  { log "[WARN]     $*"; }

echo "========================================"
echo "OpenClaw Security Hardening"
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "========================================"

# --- UFW ---
check "UFW firewall"
UFW_STATUS=$(ssh "${SSH_OPTS[@]}" "$ROOT_TARGET" "ufw status 2>/dev/null | head -1 || echo 'not installed'")
if echo "$UFW_STATUS" | grep -q "Status: active"; then
  skip "UFW already active"
else
  ssh "${SSH_OPTS[@]}" "$ROOT_TARGET" bash -s <<'REMOTE'
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh comment 'SSH access'
echo 'y' | ufw enable
REMOTE
  done_ "UFW enabled"
fi

# --- fail2ban ---
check "fail2ban"
F2B=$(ssh "${SSH_OPTS[@]}" "$ROOT_TARGET" "systemctl is-active fail2ban 2>/dev/null || echo inactive")
if [[ "$F2B" == "active" ]]; then
  skip "fail2ban already running"
else
  ssh "${SSH_OPTS[@]}" "$ROOT_TARGET" "systemctl enable fail2ban && systemctl start fail2ban"
  done_ "fail2ban enabled"
fi

# --- File permissions ---
check "File permissions"
ssh "${SSH_OPTS[@]}" "$ROOT_TARGET" bash -s <<'REMOTE'
changed=0
dir_mode=$(stat -c '%a' /home/openclaw/.openclaw 2>/dev/null || echo "000")
conf_mode=$(stat -c '%a' /home/openclaw/.openclaw/openclaw.json 2>/dev/null || echo "000")

if [[ "$dir_mode" != "700" ]]; then
  chmod 700 /home/openclaw/.openclaw
  changed=1
fi
if [[ "$conf_mode" != "600" ]]; then
  chmod 600 /home/openclaw/.openclaw/openclaw.json
  changed=1
fi
chown -R openclaw:openclaw /home/openclaw/.openclaw

if [[ $changed -eq 0 ]]; then
  echo "[SKIP]     permissions already correct"
else
  echo "[DONE]     permissions fixed"
fi
REMOTE

# --- Gateway bind to loopback ---
check "Gateway bind=loopback"
BIND=$(ssh "${SSH_OPTS[@]}" "$OC_TARGET" bash -s <<'REMOTE'
export PATH=$(npm prefix -g 2>/dev/null)/bin:$PATH
python3 -c "
import json
with open('$HOME/.openclaw/openclaw.json') as f:
    c = json.load(f)
print(c.get('gateway',{}).get('bind','NOT_SET'))
" 2>/dev/null || echo "UNKNOWN"
REMOTE
)
if [[ "$BIND" == "loopback" ]] || [[ "$BIND" == "127.0.0.1" ]]; then
  skip "gateway.bind=$BIND"
else
  ssh "${SSH_OPTS[@]}" "$OC_TARGET" bash -s <<'REMOTE'
export PATH=$(npm prefix -g 2>/dev/null)/bin:$PATH
openclaw config set gateway.bind loopback
REMOTE
  done_ "gateway.bind set to loopback"
fi

# --- mDNS off ---
check "mDNS disabled"
MDNS=$(ssh "${SSH_OPTS[@]}" "$OC_TARGET" bash -s <<'REMOTE'
python3 -c "
import json
with open('$HOME/.openclaw/openclaw.json') as f:
    c = json.load(f)
print(c.get('discovery',{}).get('mdns',{}).get('mode','NOT_SET'))
" 2>/dev/null || echo "UNKNOWN"
REMOTE
)
if [[ "$MDNS" == "off" ]]; then
  skip "mdns already off"
else
  ssh "${SSH_OPTS[@]}" "$OC_TARGET" bash -s <<'REMOTE'
export PATH=$(npm prefix -g 2>/dev/null)/bin:$PATH
openclaw config set discovery.mdns.mode off
REMOTE
  done_ "mDNS disabled"
fi

# --- dmScope ---
check "session.dmScope"
SCOPE=$(ssh "${SSH_OPTS[@]}" "$OC_TARGET" bash -s <<'REMOTE'
python3 -c "
import json
with open('$HOME/.openclaw/openclaw.json') as f:
    c = json.load(f)
print(c.get('session',{}).get('dmScope','NOT_SET'))
" 2>/dev/null || echo "UNKNOWN"
REMOTE
)
if [[ "$SCOPE" == "per-channel-peer" ]]; then
  skip "dmScope=$SCOPE"
else
  ssh "${SSH_OPTS[@]}" "$OC_TARGET" bash -s <<'REMOTE'
export PATH=$(npm prefix -g 2>/dev/null)/bin:$PATH
openclaw config set session.dmScope per-channel-peer
REMOTE
  done_ "dmScope set to per-channel-peer"
fi

# --- Elevated tools ---
check "tools.elevated.enabled"
ELEVATED=$(ssh "${SSH_OPTS[@]}" "$OC_TARGET" bash -s <<'REMOTE'
python3 -c "
import json
with open('$HOME/.openclaw/openclaw.json') as f:
    c = json.load(f)
print(c.get('tools',{}).get('elevated',{}).get('enabled','NOT_SET'))
" 2>/dev/null || echo "UNKNOWN"
REMOTE
)
if [[ "$ELEVATED" == "False" ]] || [[ "$ELEVATED" == "false" ]]; then
  skip "tools.elevated already disabled"
else
  ssh "${SSH_OPTS[@]}" "$OC_TARGET" bash -s <<'REMOTE'
export PATH=$(npm prefix -g 2>/dev/null)/bin:$PATH
openclaw config set tools.elevated.enabled false
REMOTE
  done_ "tools.elevated disabled"
fi

# --- SSH Hardening ---
echo ""
echo "========================================"
echo "WARNING: SSH HARDENING"
echo ""
echo "  The next step will disable root login and password"
echo "  authentication for SSH. Before continuing, verify:"
echo ""
echo "  1. You can SSH in as the openclaw user with a key"
echo "  2. Your SSH key is in /home/openclaw/.ssh/authorized_keys"
echo "  3. You have tested: ssh openclaw@HOST 'echo OK'"
echo ""
echo "  If key-based auth is NOT working, this step will"
echo "  LOCK YOU OUT of the server."
echo "========================================"
echo ""

check "SSH hardening (sshd_config)"
ssh "${SSH_OPTS[@]}" "$ROOT_TARGET" bash -s <<'REMOTE'
changed=0

current_root=$(grep -E '^PermitRootLogin' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}')
current_pass=$(grep -E '^PasswordAuthentication' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}')
current_max=$(grep -E '^MaxAuthTries' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}')

if [[ "$current_root" == "no" ]] && [[ "$current_pass" == "no" ]] && [[ -n "$current_max" ]]; then
  echo "[SKIP]     sshd_config already hardened"
  exit 0
fi

cp /etc/ssh/sshd_config "/etc/ssh/sshd_config.bak.$(date +%Y%m%d%H%M%S)"

if [[ "$current_root" != "no" ]]; then
  sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
  grep -q '^PermitRootLogin' /etc/ssh/sshd_config || echo 'PermitRootLogin no' >> /etc/ssh/sshd_config
  changed=1
fi

if [[ "$current_pass" != "no" ]]; then
  sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  grep -q '^PasswordAuthentication' /etc/ssh/sshd_config || echo 'PasswordAuthentication no' >> /etc/ssh/sshd_config
  changed=1
fi

if [[ -z "$current_max" ]]; then
  sed -i 's/^#*MaxAuthTries.*/MaxAuthTries 3/' /etc/ssh/sshd_config
  grep -q '^MaxAuthTries' /etc/ssh/sshd_config || echo 'MaxAuthTries 3' >> /etc/ssh/sshd_config
  changed=1
fi

if [[ $changed -eq 1 ]]; then
  if sshd -t; then
    systemctl reload sshd
    echo "[DONE]     sshd_config hardened"
  else
    echo "[FAIL]     sshd_config validation failed — check backup"
  fi
else
  echo "[SKIP]     sshd_config already hardened"
fi
REMOTE

# --- Systemd hardening ---
check "Systemd service hardening"
ssh "${SSH_OPTS[@]}" "$OC_TARGET" bash -s <<'REMOTE'
SVC_FILE=$(systemctl --user show openclaw-gateway -p FragmentPath --value 2>/dev/null)
if [[ -z "$SVC_FILE" ]] || [[ ! -f "$SVC_FILE" ]]; then
  echo "[SKIP]     no native service file found"
  exit 0
fi

if grep -q 'NoNewPrivileges=yes' "$SVC_FILE" && grep -q 'PrivateTmp=yes' "$SVC_FILE" && grep -q 'ProtectSystem' "$SVC_FILE"; then
  echo "[SKIP]     systemd hardening already present"
else
  if ! grep -q 'NoNewPrivileges' "$SVC_FILE"; then
    sed -i '/^\[Service\]/a NoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=full' "$SVC_FILE"
    echo "[DONE]     added hardening directives"
  fi
  systemctl --user daemon-reload
  systemctl --user restart openclaw-gateway || true
fi
REMOTE

# --- Restart gateway to pick up config changes ---
check "Gateway restart"
ssh "${SSH_OPTS[@]}" "$OC_TARGET" bash -s <<'REMOTE'
if systemctl --user is-active openclaw-gateway &>/dev/null; then
  systemctl --user restart openclaw-gateway
  sleep 3
  systemctl --user is-active openclaw-gateway && echo "[DONE]     gateway restarted" || echo "[WARN]     gateway failed to restart"
elif command -v docker &>/dev/null && docker inspect openclaw-gateway &>/dev/null 2>&1; then
  docker restart openclaw-gateway
  sleep 5
  echo "[DONE]     docker container restarted"
else
  echo "[SKIP]     no running gateway found"
fi
REMOTE

echo ""
echo "========================================"
echo "Hardening complete. Run the security audit to verify:"
echo "  bash scripts/vps-security-audit.sh $ROOT_TARGET $OC_TARGET"
echo "========================================"
