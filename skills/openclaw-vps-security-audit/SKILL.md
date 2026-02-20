---
name: openclaw-vps-security-audit
version: 2.0.0
description: Clawdfather-native VPS security audit playbook for OpenClaw. Executes directly via SSH — checks firewall, systemd hardening, file permissions, SSH config, Docker security, and generates a compliance report. Covers native and Docker variants.
author: clawdfather
---

# OpenClaw VPS Security Audit — Clawdfather Playbook

This skill is a **read-only audit** followed by **targeted hardening**. Collect all findings first, then apply fixes in order of severity. Do not apply fixes blindly.

---

## Audit Overview

| Audit Section | Checks | Apply To |
|--------------|--------|----------|
| [A1] Firewall (UFW) | Rules, default policy, exposed ports | Both |
| [A2] OpenClaw Config | Bind address, auth, mDNS, dmPolicy, tools | Both |
| [A3] File Permissions | .openclaw dir, config, credentials | Both |
| [A4] SSH Hardening | Root login, password auth, key-only | Both |
| [A5] Systemd Hardening | Service security flags, user isolation | Native |
| [A6] Docker Security | Image user, network isolation, volumes | Docker |
| [A7] System Hygiene | OS updates, fail2ban, unused services | Both |
| [A8] Access Control | Pairing lists, DM policies, allowlists | Both |

---

## Full Audit — Collect All Data First

Run this single command to gather everything. Review output before making any changes.

```bash
ssh {TARGET_USER}@{TARGET_HOST} "
  echo '=============================='
  echo 'OPENCLAW SECURITY AUDIT REPORT'
  echo 'Host:' \$(hostname)
  echo 'Date:' \$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo '=============================='

  # --- A1: Firewall ---
  echo ''
  echo '[A1] FIREWALL'
  echo '--- UFW Status ---'
  ufw status verbose 2>/dev/null || echo 'UFW: NOT INSTALLED'
  echo '--- Listening Ports (non-loopback) ---'
  ss -tlnp | grep -v '127.0.0.1' | grep -v '::1' | grep -v '0.0.0.0:22 '
  echo '--- All Listening Ports ---'
  ss -tlnp

  # --- A2: OpenClaw Config ---
  echo ''
  echo '[A2] OPENCLAW CONFIG'
  python3 -c \"
import json, sys
try:
    with open('/home/openclaw/.openclaw/openclaw.json') as f:
        c = json.load(f)
    gw = c.get('gateway', {})
    auth = gw.get('auth', {})
    tools = c.get('tools', {})
    disc = c.get('discovery', {})
    sess = c.get('session', {})
    print('gateway.bind:', gw.get('bind', 'NOT SET'))
    print('gateway.port:', gw.get('port', 'NOT SET'))
    print('gateway.auth.mode:', auth.get('mode', 'NOT SET'))
    token = auth.get('token', '')
    print('gateway.auth.token:', 'SET (len=' + str(len(token)) + ')' if token else 'NOT SET')
    print('discovery.mdns.mode:', disc.get('mdns', {}).get('mode', 'NOT SET'))
    print('session.dmScope:', sess.get('dmScope', 'NOT SET'))
    print('tools.deny:', tools.get('deny', []))
    print('tools.elevated.enabled:', tools.get('elevated', {}).get('enabled', 'NOT SET'))
    print('tools.exec.security:', tools.get('exec', {}).get('security', 'NOT SET'))
    channels = c.get('channels', {})
    for ch, cfg in channels.items():
        print(f'channels.{ch}.dmPolicy:', cfg.get('dmPolicy', 'NOT SET'))
        print(f'channels.{ch}.enabled:', cfg.get('enabled', 'NOT SET'))
except Exception as e:
    print('CONFIG READ ERROR:', e)
\" 2>/dev/null

  # --- A3: File Permissions ---
  echo ''
  echo '[A3] FILE PERMISSIONS'
  stat -c '%a %U:%G %n' /home/openclaw/.openclaw 2>/dev/null || echo '.openclaw dir: NOT FOUND'
  stat -c '%a %U:%G %n' /home/openclaw/.openclaw/openclaw.json 2>/dev/null || echo 'openclaw.json: NOT FOUND'
  find /home/openclaw/.openclaw/credentials/ -maxdepth 2 -exec stat -c '%a %U:%G %n' {} \; 2>/dev/null | head -20 || echo 'credentials/: NOT FOUND or EMPTY'
  echo '--- Session Transcripts (world-readable check) ---'
  find /home/openclaw/.openclaw/agents/ -name '*.jsonl' -perm /o+r -ls 2>/dev/null | head -5 || echo 'No world-readable session files'

  # --- A4: SSH Config ---
  echo ''
  echo '[A4] SSH CONFIG'
  grep -E '^(PermitRootLogin|PasswordAuthentication|PubkeyAuthentication|AuthorizedKeysFile|Port|AllowUsers|MaxAuthTries)' /etc/ssh/sshd_config 2>/dev/null || echo 'Cannot read sshd_config'
  echo 'SSH port(s) listening:'
  ss -tlnp | grep ':22 '

  # --- A5: Systemd Service ---
  echo ''
  echo '[A5] SYSTEMD HARDENING'
  systemctl --user cat openclaw-gateway 2>/dev/null | grep -E '(NoNewPrivileges|PrivateTmp|ProtectSystem|ProtectHome|ReadWritePaths|DynamicUser|User=|Group=)' || echo 'Service file not found or no hardening directives'
  echo 'Service running as user:'
  systemctl --user show openclaw-gateway --property=User 2>/dev/null || echo 'N/A'

  # --- A6: Docker Security ---
  echo ''
  echo '[A6] DOCKER SECURITY'
  docker inspect openclaw-gateway 2>/dev/null | python3 -c \"
import json, sys
containers = json.load(sys.stdin)
if not containers:
    print('Container not found')
    sys.exit()
c = containers[0]
cfg = c.get('HostConfig', {})
print('User:', c.get('Config', {}).get('User', 'NOT SET (root!)'))
print('ReadonlyRootfs:', cfg.get('ReadonlyRootfs', False))
print('NetworkMode:', cfg.get('NetworkMode', 'NOT SET'))
print('Privileged:', cfg.get('Privileged', False))
caps = cfg.get('CapDrop', [])
print('CapDrop:', caps)
print('PidsLimit:', cfg.get('PidsLimit', 'unlimited'))
mem = cfg.get('Memory', 0)
print('Memory limit:', str(mem // 1024 // 1024) + 'MB' if mem else 'unlimited')
ports = c.get('NetworkSettings', {}).get('Ports', {})
for p, bindings in ports.items():
    if bindings:
        for b in bindings:
            print(f'Port binding: {b[\"HostIp\"]}:{b[\"HostPort\"]} -> {p}')
\" 2>/dev/null || echo 'Docker not installed or container not running'

  # --- A7: System Hygiene ---
  echo ''
  echo '[A7] SYSTEM HYGIENE'
  echo 'Pending security updates:'
  apt list --upgradable 2>/dev/null | grep -i security | wc -l
  echo 'fail2ban status:'
  systemctl is-active fail2ban 2>/dev/null || echo 'fail2ban: NOT RUNNING'
  echo 'Unnecessary listening services (non-standard):'
  ss -tlnp | grep -v ':22 ' | grep -v ':18789 ' | grep -v ':53 ' | grep LISTEN
  echo 'Root-owned SUID files in /usr:'
  find /usr -perm -4000 -user root -type f 2>/dev/null | head -10

  # --- A8: Access Control ---
  echo ''
  echo '[A8] ACCESS CONTROL'
  echo 'Pairing allowlists:'
  for f in /home/openclaw/.openclaw/credentials/*-allowFrom.json; do
    echo \"--- \$f ---\"
    cat \"\$f\" 2>/dev/null | python3 -m json.tool 2>/dev/null | head -20 || echo 'empty or invalid'
  done
  echo 'Sudo access for openclaw user:'
  groups openclaw | tr ' ' '\n' | grep -E 'sudo|wheel|admin' || echo 'not in privileged groups'

  echo ''
  echo '=============================='
  echo 'END AUDIT DATA'
  echo '=============================='
" 2>&1
```

---

## Audit Findings Evaluation

After collecting data, evaluate each section against these benchmarks:

### [A1] Firewall Evaluation

| Check | Expected | Severity if Wrong |
|-------|----------|-------------------|
| UFW status | `Status: active` | 🔴 CRITICAL |
| UFW default incoming | `DENY` | 🔴 CRITICAL |
| Only SSH open externally | Port 22 only | 🔴 CRITICAL |
| Port 18789 not on 0.0.0.0 | Not listed or loopback only | 🔴 CRITICAL |

**Findings decision:**
- UFW inactive → **FAIL: [A1-1]** Firewall not running
- Port 18789 bound to `0.0.0.0` → **FAIL: [A1-2]** Gateway publicly exposed
- Unexpected ports open → **FAIL: [A1-3]** Unexpected service exposed

### [A2] OpenClaw Config Evaluation

| Check | Expected | Severity if Wrong |
|-------|----------|-------------------|
| `gateway.bind` | `loopback` or `127.0.0.1` | 🔴 CRITICAL |
| `gateway.auth.mode` | `token` | 🔴 CRITICAL |
| `gateway.auth.token` | SET, length >= 32 | 🔴 CRITICAL |
| `discovery.mdns.mode` | `off` or `minimal` | 🟡 MEDIUM |
| `session.dmScope` | `per-channel-peer` | 🟡 MEDIUM |
| `tools.deny` includes `gateway`, `cron` | Yes | 🟡 MEDIUM |
| `tools.elevated.enabled` | `False` or `NOT SET` | 🟠 HIGH |
| `tools.exec.security` | `ask` or `deny` | 🟠 HIGH |
| `channels.*.dmPolicy` | `pairing` or `allowlist` | 🟠 HIGH |

### [A3] File Permissions Evaluation

| Check | Expected | Severity if Wrong |
|-------|----------|-------------------|
| `.openclaw` dir mode | `700` | 🟠 HIGH |
| `openclaw.json` mode | `600` | 🔴 CRITICAL |
| `credentials/` files mode | `600` | 🔴 CRITICAL |
| No world-readable session files | None | 🟡 MEDIUM |

### [A4] SSH Config Evaluation

| Check | Expected | Severity if Wrong |
|-------|----------|-------------------|
| `PermitRootLogin` | `no` | 🟠 HIGH |
| `PasswordAuthentication` | `no` | 🟠 HIGH |
| `PubkeyAuthentication` | `yes` | 🟠 HIGH |
| `MaxAuthTries` | `3` or less | 🟡 MEDIUM |

### [A5] Systemd Hardening (Native) Evaluation

| Check | Expected | Severity if Wrong |
|-------|----------|-------------------|
| `NoNewPrivileges=yes` | Present | 🟡 MEDIUM |
| `PrivateTmp=yes` | Present | 🟡 MEDIUM |
| `ProtectSystem` | `full` or `strict` | 🟡 MEDIUM |
| Service user | `openclaw` (not root) | 🟠 HIGH |

### [A6] Docker Security (Docker) Evaluation

| Check | Expected | Severity if Wrong |
|-------|----------|-------------------|
| Container user | `1000` (not root) | 🟠 HIGH |
| `ReadonlyRootfs` | `true` | 🟡 MEDIUM |
| `Privileged` | `false` | 🔴 CRITICAL |
| `NetworkMode` | `bridge` or `none` for sandboxes | 🟡 MEDIUM |
| Port binding | `127.0.0.1:18789` (not `0.0.0.0`) | 🔴 CRITICAL |
| `CapDrop` | `ALL` listed | 🟡 MEDIUM |
| Memory limit | Set (≤2GB) | 🟡 MEDIUM |

---

## Hardening Fixes

Apply only the fixes relevant to your findings. Run in order of severity (CRITICAL first).

### Fix A1-1 — Enable UFW Firewall

```bash
ssh {TARGET_USER}@{TARGET_HOST} "
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow ssh comment 'SSH access'
  echo 'y' | ufw enable
  ufw status verbose && echo UFW_ENABLED
"
```

### Fix A1-2 — Rebind Gateway to Loopback

```bash
ssh openclaw@{TARGET_HOST} "
  export PATH=\$(npm prefix -g)/bin:\$PATH
  openclaw config set gateway.bind loopback
  openclaw gateway restart
  sleep 3
  ss -tlnp | grep 18789 && echo BIND_CHECK_DONE
"
```

For Docker, edit `.env`:
```bash
ssh openclaw@{TARGET_HOST} "
  sed -i 's/OPENCLAW_GATEWAY_BIND=lan/OPENCLAW_GATEWAY_BIND=loopback/' ~/openclaw/.env
  # Also update docker-compose.yml port binding
  sed -i 's/\"18789:18789\"/\"127.0.0.1:18789:18789\"/' ~/openclaw/docker-compose.yml
  docker compose -f ~/openclaw/docker-compose.yml up -d
  echo DOCKER_BIND_FIXED
"
```

### Fix A2-1 — Set Missing Gateway Token

```bash
ssh openclaw@{TARGET_HOST} "
  export PATH=\$(npm prefix -g)/bin:\$PATH
  NEW_TOKEN=\$(openssl rand -hex 32)
  openclaw config set gateway.auth.mode token
  openclaw config set gateway.auth.token \"\$NEW_TOKEN\"
  openclaw gateway restart
  echo NEW_TOKEN: \$NEW_TOKEN
  echo TOKEN_SET
"
```

**Record the new token securely.**

### Fix A2-2 — Disable mDNS

```bash
ssh openclaw@{TARGET_HOST} "
  export PATH=\$(npm prefix -g)/bin:\$PATH
  openclaw config set discovery.mdns.mode off
  openclaw gateway restart
  echo MDNS_DISABLED
"
```

### Fix A2-3 — Harden Tool Config

```bash
ssh openclaw@{TARGET_HOST} "
  export PATH=\$(npm prefix -g)/bin:\$PATH
  openclaw config set session.dmScope per-channel-peer
  openclaw config set tools.elevated.enabled false
  openclaw config set tools.exec.security ask
  openclaw config set tools.exec.ask always
  openclaw gateway restart
  echo TOOLS_HARDENED
"
```

For `tools.deny`, edit `openclaw.json` directly (array values not settable via `config set`):
```bash
ssh openclaw@{TARGET_HOST} "
  python3 << 'PYEOF'
import json
with open('/home/openclaw/.openclaw/openclaw.json', 'r') as f:
    c = json.load(f)
c.setdefault('tools', {})['deny'] = ['gateway', 'cron', 'sessions_spawn', 'sessions_send']
with open('/home/openclaw/.openclaw/openclaw.json', 'w') as f:
    json.dump(c, f, indent=2)
print('TOOLS_DENY_SET')
PYEOF
"
```

### Fix A2-4 — Set DM Policy on Channels

```bash
ssh openclaw@{TARGET_HOST} "
  export PATH=\$(npm prefix -g)/bin:\$PATH
  # Set for each active channel
  openclaw config set channels.telegram.dmPolicy pairing 2>/dev/null || true
  openclaw config set channels.discord.dmPolicy pairing 2>/dev/null || true
  openclaw gateway restart
  echo DM_POLICY_SET
"
```

### Fix A3-1 — Fix File Permissions

```bash
ssh {TARGET_USER}@{TARGET_HOST} "
  chown -R openclaw:openclaw /home/openclaw/.openclaw
  chmod 700 /home/openclaw/.openclaw
  chmod 600 /home/openclaw/.openclaw/openclaw.json
  find /home/openclaw/.openclaw/credentials/ -type f -exec chmod 600 {} \; 2>/dev/null || true
  find /home/openclaw/.openclaw/credentials/ -type d -exec chmod 700 {} \; 2>/dev/null || true
  find /home/openclaw/.openclaw/agents/ -name '*.jsonl' -exec chmod 600 {} \; 2>/dev/null || true
  echo PERMISSIONS_FIXED
"
```

### Fix A4-1 — Harden SSH Config

```bash
ssh {TARGET_USER}@{TARGET_HOST} "
  cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak.\$(date +%Y%m%d)
  
  # Disable root login
  sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
  grep -q 'PermitRootLogin' /etc/ssh/sshd_config || echo 'PermitRootLogin no' >> /etc/ssh/sshd_config
  
  # Disable password auth (key-only)
  sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  grep -q 'PasswordAuthentication' /etc/ssh/sshd_config || echo 'PasswordAuthentication no' >> /etc/ssh/sshd_config
  
  # Enable pubkey auth
  sed -i 's/^#*PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
  grep -q 'PubkeyAuthentication' /etc/ssh/sshd_config || echo 'PubkeyAuthentication yes' >> /etc/ssh/sshd_config
  
  # Set max auth tries
  sed -i 's/^#*MaxAuthTries.*/MaxAuthTries 3/' /etc/ssh/sshd_config
  grep -q 'MaxAuthTries' /etc/ssh/sshd_config || echo 'MaxAuthTries 3' >> /etc/ssh/sshd_config
  
  # Test config before reloading
  sshd -t && systemctl reload sshd && echo SSH_HARDENED || echo SSH_CONFIG_ERROR_REVERTING
"
```

**⚠️ WARNING:** Ensure you have SSH key access BEFORE running this fix. Disabling password auth without a working key will lock you out.

### Fix A5-1 — Add Systemd Hardening Directives (Native)

```bash
ssh {TARGET_USER}@{TARGET_HOST} "
  # Find service file path
  SERVICE_FILE=\$(systemctl --user show openclaw-gateway -p FragmentPath --value 2>/dev/null)
  echo Service file: \$SERVICE_FILE
  
  if [ -z \"\$SERVICE_FILE\" ]; then
    echo 'Service file not found; run: openclaw gateway install'
    exit 1
  fi
  
  # Add hardening to [Service] section if not already present
  grep -q 'NoNewPrivileges' \"\$SERVICE_FILE\" || sed -i '/^\[Service\]/a NoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=full\nProtectHome=read-only\nReadWritePaths=%h/.openclaw %h/.npm' \"\$SERVICE_FILE\"
  
  systemctl --user daemon-reload
  systemctl --user restart openclaw-gateway
  echo SYSTEMD_HARDENED
"
```

### Fix A6-1 — Harden Docker Container

Update `docker-compose.yml` to add security options:

```bash
ssh openclaw@{TARGET_HOST} "
  cat >> ~/openclaw/docker-compose.yml << 'APPEND'
# Security hardening additions (appended by security audit)
# Move these to the service definition manually
# security_opt:
#   - no-new-privileges:true
# read_only: true
# user: '1000:1000'
# cap_drop:
#   - ALL
# mem_limit: 2g
# pids_limit: 512
APPEND
  echo 'See ~/openclaw/docker-compose.yml for recommended additions'
  echo 'Edit manually to add security_opt, read_only, user, cap_drop, mem_limit'
"
```

**Recommended docker-compose security block:**
```yaml
services:
  openclaw-gateway:
    # ... existing config ...
    user: "1000:1000"
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    mem_limit: 2g
    pids_limit: 512
    tmpfs:
      - /tmp
      - /var/tmp
```

### Fix A7-1 — Apply Security Updates

```bash
ssh {TARGET_USER}@{TARGET_HOST} "
  apt-get update -qq
  apt-get upgrade -y --only-upgrade
  echo UPDATES_APPLIED
"
```

### Fix A7-2 — Ensure Fail2Ban Running

```bash
ssh {TARGET_USER}@{TARGET_HOST} "
  apt-get install -y fail2ban
  systemctl enable fail2ban
  systemctl start fail2ban
  fail2ban-client status && echo FAIL2BAN_OK
"
```

---

## Report Generation

After completing audit and fixes, generate the final compliance report:

```bash
ssh openclaw@{TARGET_HOST} "
  echo '=============================='
  echo 'OPENCLAW SECURITY COMPLIANCE REPORT'
  echo 'Host:' \$(hostname)
  echo 'Date:' \$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo '=============================='

  pass=0; warn=0; fail=0

  check() {
    local name='\$1' result='\$2' expected='\$3' sev='\$4'
    if eval \"\$result\" | grep -q \"\$expected\"; then
      echo \"✅ PASS  \$name\"
      pass=\$((pass+1))
    else
      echo \"\$sev FAIL  \$name\"
      fail=\$((fail+1))
    fi
  }

  echo ''
  echo '--- Firewall ---'
  ufw status | grep -q 'Status: active' && echo '✅ PASS  UFW active' && pass=\$((pass+1)) || (echo '🔴 FAIL  UFW active'; fail=\$((fail+1)))
  ss -tlnp | grep 18789 | grep -qv '127.0.0.1' && (echo '🔴 FAIL  Port 18789 publicly exposed'; fail=\$((fail+1))) || (echo '✅ PASS  Port 18789 loopback-only'; pass=\$((pass+1)))

  echo ''
  echo '--- OpenClaw Config ---'
  python3 << 'PYEOF'
import json
try:
    with open('/home/openclaw/.openclaw/openclaw.json') as f:
        c = json.load(f)
    gw = c.get('gateway', {})
    auth = gw.get('auth', {})
    tools = c.get('tools', {})
    disc = c.get('discovery', {})

    checks = [
        ('gateway.bind=loopback', gw.get('bind') in ['loopback', '127.0.0.1'], '🔴'),
        ('gateway.auth.mode=token', auth.get('mode') == 'token', '🔴'),
        ('gateway.auth.token set (>=32 chars)', len(auth.get('token','')) >= 32, '🔴'),
        ('mdns mode=off/minimal', disc.get('mdns',{}).get('mode') in ['off','minimal'], '🟡'),
        ('tools.elevated.enabled=false', tools.get('elevated',{}).get('enabled') is False, '🟠'),
        ('tools.exec.security=ask/deny', tools.get('exec',{}).get('security') in ['ask','deny'], '🟠'),
        ('session.dmScope=per-channel-peer', c.get('session',{}).get('dmScope') == 'per-channel-peer', '🟡'),
        ('tools.deny includes gateway+cron', all(x in tools.get('deny',[]) for x in ['gateway','cron']), '🟡'),
    ]
    for name, result, sev in checks:
        icon = '✅ PASS' if result else f'{sev} FAIL'
        print(f'{icon}  {name}')
except Exception as e:
    print(f'🔴 ERROR  Config read failed: {e}')
PYEOF

  echo ''
  echo '--- File Permissions ---'
  oclaw_mode=\$(stat -c '%a' /home/openclaw/.openclaw 2>/dev/null)
  conf_mode=\$(stat -c '%a' /home/openclaw/.openclaw/openclaw.json 2>/dev/null)
  [ \"\$oclaw_mode\" = '700' ] && echo '✅ PASS  .openclaw dir mode=700' && pass=\$((pass+1)) || (echo '🟠 FAIL  .openclaw dir mode='\$oclaw_mode' (want 700)'; fail=\$((fail+1)))
  [ \"\$conf_mode\" = '600' ] && echo '✅ PASS  openclaw.json mode=600' && pass=\$((pass+1)) || (echo '🔴 FAIL  openclaw.json mode='\$conf_mode' (want 600)'; fail=\$((fail+1)))

  echo ''
  echo '--- SSH Config ---'
  grep -q 'PasswordAuthentication no' /etc/ssh/sshd_config && echo '✅ PASS  PasswordAuthentication=no' && pass=\$((pass+1)) || (echo '🟠 FAIL  PasswordAuthentication not disabled'; fail=\$((fail+1)))
  grep -q 'PermitRootLogin no' /etc/ssh/sshd_config && echo '✅ PASS  PermitRootLogin=no' && pass=\$((pass+1)) || (echo '🟡 WARN  PermitRootLogin not set to no'; warn=\$((warn+1)))

  echo ''
  echo '--- System Hygiene ---'
  systemctl is-active fail2ban &>/dev/null && echo '✅ PASS  fail2ban running' && pass=\$((pass+1)) || (echo '🟡 WARN  fail2ban not running'; warn=\$((warn+1)))
  pending=\$(apt list --upgradable 2>/dev/null | grep -c security 2>/dev/null || echo 0)
  [ \"\$pending\" -eq 0 ] && echo '✅ PASS  No pending security updates' && pass=\$((pass+1)) || (echo '🟡 WARN  '\$pending' pending security update(s)'; warn=\$((warn+1)))

  echo ''
  echo '=============================='
  echo \"SUMMARY: \$pass PASS | \$warn WARN | \$fail FAIL\"
  if [ \$fail -eq 0 ] && [ \$warn -eq 0 ]; then
    echo 'STATUS: ✅ FULLY COMPLIANT'
  elif [ \$fail -eq 0 ]; then
    echo 'STATUS: 🟡 COMPLIANT WITH WARNINGS'
  else
    echo 'STATUS: 🔴 NON-COMPLIANT — ACTION REQUIRED'
  fi
  echo '=============================='
" 2>&1
```

---

## Severity Key

| Icon | Severity | Action Required |
|------|----------|----------------|
| 🔴 CRITICAL | Gateway exposed or auth missing | Fix immediately before using |
| 🟠 HIGH | Privilege escalation or data exposure risk | Fix within 24h |
| 🟡 MEDIUM | Defense-in-depth weakened | Fix within 7 days |
| 🟢 LOW | Minor improvement opportunity | Fix when convenient |
| ✅ PASS | Compliant | No action needed |

---

## Audit Schedule Recommendations

| Frequency | Trigger |
|-----------|---------|
| Every install / update | Run full audit after any deployment change |
| Weekly (automated) | Schedule via `openclaw security audit` or cron |
| After incident | Full audit + credential rotation |
| Before sharing access | Verify DM policies and allowlists |

---

## Quick Hardening Checklist (Fast Path)

For rapid remediation of the most critical issues:

```bash
ssh {TARGET_USER}@{TARGET_HOST} "
  # 1. UFW on
  ufw default deny incoming && ufw allow ssh && echo 'y' | ufw enable

  # 2. Fail2ban
  systemctl enable fail2ban && systemctl start fail2ban

  # 3. Fix openclaw permissions
  chmod 700 /home/openclaw/.openclaw
  chmod 600 /home/openclaw/.openclaw/openclaw.json
  chown -R openclaw:openclaw /home/openclaw/.openclaw

  echo QUICK_HARDENING_DONE
"

ssh openclaw@{TARGET_HOST} "
  export PATH=\$(npm prefix -g)/bin:\$PATH
  # 4. Rebind to loopback
  openclaw config set gateway.bind loopback
  # 5. Disable mDNS
  openclaw config set discovery.mdns.mode off
  # 6. Set DM scope
  openclaw config set session.dmScope per-channel-peer
  # 7. Disable elevated tools
  openclaw config set tools.elevated.enabled false

  openclaw gateway restart
  sleep 3
  openclaw health && echo GATEWAY_HEALTHY
"
```

---

## Native vs Docker: Security Comparison

| Concern | Native | Docker |
|---------|--------|--------|
| Process isolation | systemd only | Container namespace |
| Filesystem isolation | Directory permissions | Container root + volumes |
| Network isolation | UFW + loopback bind | UFW + container network |
| Privilege escalation | User account isolation | Container + `no-new-privileges` |
| Binary attack surface | Node.js process on host | Contained in image |
| Update surface | Host OS + Node.js + OpenClaw | Image rebuild required |
| Rollback | `npm i -g openclaw@version` | Image tag swap |
| Audit complexity | Lower | Higher (image layers) |

**Both variants** need UFW, loopback binding, file permissions, and SSH hardening.  
**Docker additionally** needs: non-root user, `read_only: true`, `cap_drop: [ALL]`, port binding to `127.0.0.1`.
