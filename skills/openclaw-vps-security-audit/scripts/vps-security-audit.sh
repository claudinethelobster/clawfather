#!/usr/bin/env bash
set -euo pipefail

# Full security audit: UFW, openclaw config, file permissions, sshd, systemd
# hardening, docker security, fail2ban, pending updates. Prints findings with severity.

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

PASS=0
HIGH=0
CRIT=0
MED=0

finding() {
  local sev="$1" label="$2"
  case "$sev" in
    PASS)     echo "  PASS     $label"; PASS=$((PASS+1)) ;;
    CRITICAL) echo "  CRITICAL $label"; CRIT=$((CRIT+1)) ;;
    HIGH)     echo "  HIGH     $label"; HIGH=$((HIGH+1)) ;;
    MEDIUM)   echo "  MEDIUM   $label"; MED=$((MED+1)) ;;
  esac
}

echo "========================================"
echo "OpenClaw Security Audit"
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "========================================"

# --- A1: Firewall ---
echo ""
echo "[A1] FIREWALL"
UFW_DATA=$(ssh "${SSH_OPTS[@]}" "$ROOT_TARGET" bash -s <<'REMOTE'
ufw status verbose 2>/dev/null || echo "UFW_NOT_INSTALLED"
echo "---PORTS---"
ss -tlnp | grep -v '127.0.0.1' | grep -v '::1'
REMOTE
)
echo "$UFW_DATA" | head -20

if echo "$UFW_DATA" | grep -q "Status: active"; then
  finding PASS "UFW active"
else
  finding CRITICAL "UFW not active"
fi

if echo "$UFW_DATA" | grep -q "18789.*0.0.0.0"; then
  finding CRITICAL "Port 18789 publicly exposed"
else
  finding PASS "Port 18789 not publicly exposed"
fi

# --- A2: OpenClaw Config ---
echo ""
echo "[A2] OPENCLAW CONFIG"
CONFIG_DATA=$(ssh "${SSH_OPTS[@]}" "$OC_TARGET" bash -s <<'REMOTE'
python3 -c "
import json, sys
try:
    with open('$HOME/.openclaw/openclaw.json') as f:
        c = json.load(f)
    gw = c.get('gateway', {})
    auth = gw.get('auth', {})
    tools = c.get('tools', {})
    disc = c.get('discovery', {})
    sess = c.get('session', {})
    print('bind=' + str(gw.get('bind', 'NOT_SET')))
    print('auth_mode=' + str(auth.get('mode', 'NOT_SET')))
    print('token_len=' + str(len(auth.get('token', ''))))
    print('mdns=' + str(disc.get('mdns', {}).get('mode', 'NOT_SET')))
    print('dmScope=' + str(sess.get('dmScope', 'NOT_SET')))
    print('elevated=' + str(tools.get('elevated', {}).get('enabled', 'NOT_SET')))
    deny = tools.get('deny', [])
    print('deny_gateway=' + str('gateway' in deny))
    print('deny_cron=' + str('cron' in deny))
except Exception as e:
    print('ERROR=' + str(e))
" 2>/dev/null
REMOTE
)

get_val() { echo "$CONFIG_DATA" | grep "^$1=" | cut -d= -f2; }

BIND=$(get_val bind)
[[ "$BIND" == "loopback" ]] || [[ "$BIND" == "127.0.0.1" ]] && finding PASS "gateway.bind=$BIND" || finding CRITICAL "gateway.bind=$BIND (want loopback)"

AUTH_MODE=$(get_val auth_mode)
[[ "$AUTH_MODE" == "token" ]] && finding PASS "gateway.auth.mode=token" || finding CRITICAL "gateway.auth.mode=$AUTH_MODE"

TOKEN_LEN=$(get_val token_len)
[[ "$TOKEN_LEN" -ge 32 ]] 2>/dev/null && finding PASS "Token length=$TOKEN_LEN" || finding CRITICAL "Token length=$TOKEN_LEN (want >=32)"

MDNS=$(get_val mdns)
[[ "$MDNS" == "off" ]] || [[ "$MDNS" == "minimal" ]] && finding PASS "mdns=$MDNS" || finding MEDIUM "mdns=$MDNS (want off)"

DMSCOPE=$(get_val dmScope)
[[ "$DMSCOPE" == "per-channel-peer" ]] && finding PASS "dmScope=$DMSCOPE" || finding MEDIUM "dmScope=$DMSCOPE (want per-channel-peer)"

ELEVATED=$(get_val elevated)
[[ "$ELEVATED" == "False" ]] || [[ "$ELEVATED" == "false" ]] && finding PASS "tools.elevated=disabled" || finding HIGH "tools.elevated=$ELEVATED (want false)"

# --- A3: File Permissions ---
echo ""
echo "[A3] FILE PERMISSIONS"
PERM_DATA=$(ssh "${SSH_OPTS[@]}" "$OC_TARGET" bash -s <<'REMOTE'
echo "dir=$(stat -c '%a' ~/.openclaw 2>/dev/null || echo 000)"
echo "conf=$(stat -c '%a' ~/.openclaw/openclaw.json 2>/dev/null || echo 000)"
REMOTE
)

DIR_MODE=$(echo "$PERM_DATA" | grep "^dir=" | cut -d= -f2)
CONF_MODE=$(echo "$PERM_DATA" | grep "^conf=" | cut -d= -f2)

[[ "$DIR_MODE" == "700" ]] && finding PASS ".openclaw dir mode=$DIR_MODE" || finding HIGH ".openclaw dir mode=$DIR_MODE (want 700)"
[[ "$CONF_MODE" == "600" ]] && finding PASS "openclaw.json mode=$CONF_MODE" || finding CRITICAL "openclaw.json mode=$CONF_MODE (want 600)"

# --- A4: SSH Config ---
echo ""
echo "[A4] SSH CONFIG"
SSH_DATA=$(ssh "${SSH_OPTS[@]}" "$ROOT_TARGET" bash -s <<'REMOTE'
grep -E '^(PermitRootLogin|PasswordAuthentication|MaxAuthTries)' /etc/ssh/sshd_config 2>/dev/null || echo "CANNOT_READ"
REMOTE
)
echo "$SSH_DATA"

if echo "$SSH_DATA" | grep -q "PermitRootLogin no"; then
  finding PASS "PermitRootLogin=no"
else
  finding HIGH "PermitRootLogin not set to no"
fi

if echo "$SSH_DATA" | grep -q "PasswordAuthentication no"; then
  finding PASS "PasswordAuthentication=no"
else
  finding HIGH "PasswordAuthentication not disabled"
fi

if echo "$SSH_DATA" | grep -q "MaxAuthTries"; then
  finding PASS "MaxAuthTries is set"
else
  finding MEDIUM "MaxAuthTries not configured"
fi

# --- A5: Systemd Hardening ---
echo ""
echo "[A5] SYSTEMD HARDENING"
SYSD_DATA=$(ssh "${SSH_OPTS[@]}" "$OC_TARGET" bash -s <<'REMOTE'
systemctl --user cat openclaw-gateway 2>/dev/null || echo "NO_SERVICE"
REMOTE
)

if echo "$SYSD_DATA" | grep -q "NoNewPrivileges=yes"; then
  finding PASS "NoNewPrivileges=yes"
else
  finding MEDIUM "NoNewPrivileges not set"
fi

if echo "$SYSD_DATA" | grep -q "PrivateTmp=yes"; then
  finding PASS "PrivateTmp=yes"
else
  finding MEDIUM "PrivateTmp not set"
fi

if echo "$SYSD_DATA" | grep -q "ProtectSystem"; then
  finding PASS "ProtectSystem is set"
else
  finding MEDIUM "ProtectSystem not set"
fi

# --- A6: Docker Security ---
echo ""
echo "[A6] DOCKER SECURITY"
DOCKER_DATA=$(ssh "${SSH_OPTS[@]}" "$OC_TARGET" bash -s <<'REMOTE'
if ! command -v docker &>/dev/null; then
  echo "DOCKER_NOT_INSTALLED"
  exit 0
fi
docker inspect openclaw-gateway 2>/dev/null | python3 -c "
import json, sys
containers = json.load(sys.stdin)
if not containers:
    print('NO_CONTAINER')
    sys.exit()
c = containers[0]
cfg = c.get('HostConfig', {})
print('user=' + (c.get('Config', {}).get('User', '') or 'root'))
print('privileged=' + str(cfg.get('Privileged', False)))
print('readonly=' + str(cfg.get('ReadonlyRootfs', False)))
ports = c.get('NetworkSettings', {}).get('Ports', {})
for p, bindings in (ports or {}).items():
    if bindings:
        for b in bindings:
            print('port_bind=' + b.get('HostIp', '0.0.0.0') + ':' + b.get('HostPort', '?'))
" 2>/dev/null || echo "DOCKER_INSPECT_FAILED"
REMOTE
)

if echo "$DOCKER_DATA" | grep -q "DOCKER_NOT_INSTALLED\|NO_CONTAINER\|DOCKER_INSPECT_FAILED"; then
  echo "  (Docker checks skipped — not applicable)"
else
  if echo "$DOCKER_DATA" | grep -q "privileged=True"; then
    finding CRITICAL "Container is privileged"
  else
    finding PASS "Container not privileged"
  fi

  if echo "$DOCKER_DATA" | grep -q "port_bind=0.0.0.0"; then
    finding CRITICAL "Docker port bound to 0.0.0.0"
  else
    finding PASS "Docker port binding OK"
  fi
fi

# --- A7: fail2ban & updates ---
echo ""
echo "[A7] SYSTEM HYGIENE"
F2B=$(ssh "${SSH_OPTS[@]}" "$ROOT_TARGET" "systemctl is-active fail2ban 2>/dev/null || echo inactive")
[[ "$F2B" == "active" ]] && finding PASS "fail2ban running" || finding MEDIUM "fail2ban not running"

UPDATES=$(ssh "${SSH_OPTS[@]}" "$ROOT_TARGET" "apt list --upgradable 2>/dev/null | grep -ci security || echo 0")
[[ "$UPDATES" -eq 0 ]] 2>/dev/null && finding PASS "No pending security updates" || finding MEDIUM "$UPDATES pending security update(s)"

# --- Summary ---
echo ""
echo "========================================"
TOTAL=$((PASS + CRIT + HIGH + MED))
echo "RESULTS: $PASS PASS | $CRIT CRITICAL | $HIGH HIGH | $MED MEDIUM  (of $TOTAL checks)"
if [[ $CRIT -gt 0 ]]; then
  echo "STATUS:  ACTION REQUIRED — $CRIT critical finding(s)"
elif [[ $HIGH -gt 0 ]]; then
  echo "STATUS:  $HIGH high-severity finding(s) — fix within 24h"
elif [[ $MED -gt 0 ]]; then
  echo "STATUS:  $MED medium findings — fix within 7 days"
else
  echo "STATUS:  ALL CHECKS PASSED"
fi
echo "========================================"
