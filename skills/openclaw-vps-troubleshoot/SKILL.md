---
name: openclaw-vps-troubleshoot
version: 2.0.0
description: Clawdfather-native VPS troubleshooting playbook for OpenClaw. Executes directly via SSH — collects diagnostics, diagnoses root causes, and applies targeted fixes. Covers native and Docker variants.
author: clawdfather
---

# OpenClaw VPS Troubleshoot — Clawdfather Playbook

This skill is a **diagnosis-first, fix-second** playbook. Always collect diagnostics first. Make decisions based on what you find. Do not apply random fixes blindly.

---

## Triage: Identify Symptom Class

Run this first to narrow the problem:

```bash
ssh openclaw@{TARGET_HOST} "
  echo '=== TRIAGE SNAPSHOT ==='
  echo -n 'Date: '; date
  echo -n 'Uptime: '; uptime
  echo ''
  echo '--- Service Status ---'
  systemctl --user is-active openclaw-gateway 2>/dev/null && echo 'NATIVE: running' || echo 'NATIVE: not running'
  docker inspect openclaw-gateway --format 'DOCKER: {{.State.Status}}' 2>/dev/null || echo 'DOCKER: not found'
  echo ''
  echo '--- Port Check ---'
  ss -tlnp | grep 18789 || echo 'Port 18789: NOT listening'
  echo ''
  echo '--- Disk Space ---'
  df -h / | tail -1
  echo ''
  echo '--- Memory ---'
  free -h | grep Mem
  echo ''
  echo '--- Last 10 Error Lines ---'
  journalctl --user -u openclaw-gateway -n 50 --no-pager 2>/dev/null | grep -i 'error\|fail\|warn' | tail -10 || echo 'No journald logs found'
  echo '=== END TRIAGE ==='
"
```

**Read the output and match to a symptom class:**

| Symptom | Go To |
|---------|-------|
| Service shows `failed` or `inactive` | [SC-1] Service Won't Start |
| Service shows `active` but port not listening | [SC-2] Gateway Not Listening |
| Port listening but health check fails | [SC-3] Gateway Unresponsive |
| Docker: container `exited` or `restarting` | [SC-4] Docker Container Issues |
| Disk > 90% full | [SC-5] Disk Space |
| Memory > 90% used | [SC-6] Memory Pressure |
| Channels not responding / bot silent | [SC-7] Channel Issues |
| Permission denied errors | [SC-8] Permission Problems |
| Service running but bot behaves wrong | [SC-9] Config / Logic Issues |

---

## [SC-1] Service Won't Start (Native)

### Diagnostics

```bash
ssh openclaw@{TARGET_HOST} "
  echo '=== Service Status ==='
  systemctl --user status openclaw-gateway --no-pager -l
  echo ''
  echo '=== Last 50 Journal Lines ==='
  journalctl --user -u openclaw-gateway -n 50 --no-pager
  echo ''
  echo '=== Service File ==='
  systemctl --user cat openclaw-gateway 2>/dev/null || echo 'No service file found'
  echo ''
  echo '=== OpenClaw Binary ==='
  export PATH=\$(npm prefix -g)/bin:\$PATH
  which openclaw 2>/dev/null && openclaw --version || echo 'openclaw: NOT FOUND'
  echo ''
  echo '=== Config File ==='
  test -f ~/.openclaw/openclaw.json && echo 'EXISTS' || echo 'MISSING'
  stat -c '%a %U' ~/.openclaw/openclaw.json 2>/dev/null || echo 'stat failed'
"
```

**Decision tree:**

- `openclaw: NOT FOUND` → Fix A: Binary missing
- `MISSING` (config file) → Fix B: Config missing
- `ExecStart` missing in service file → Fix C: Service not installed
- `EACCES` in journal → Fix D: Permissions
- `EADDRINUSE` in journal → Fix E: Port conflict
- `Error: Cannot find module` → Fix F: Node modules corrupt
- `Invalid config` / JSON parse error → Fix G: Config syntax

### Fix A — Binary Missing

```bash
ssh openclaw@{TARGET_HOST} "
  export PATH=\$(npm prefix -g)/bin:\$PATH
  # Reinstall
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
  which openclaw && openclaw --version && echo FIX_A_DONE
"
```

### Fix B — Config Missing

```bash
ssh openclaw@{TARGET_HOST} "
  mkdir -p ~/.openclaw
  # Generate a fresh token
  TOKEN=\$(openssl rand -hex 32)
  cat > ~/.openclaw/openclaw.json << CONF
{
  \"gateway\": {
    \"mode\": \"local\",
    \"bind\": \"loopback\",
    \"port\": 18789,
    \"auth\": { \"mode\": \"token\", \"token\": \"\$TOKEN\" }
  },
  \"session\": { \"dmScope\": \"per-channel-peer\" },
  \"discovery\": { \"mdns\": { \"mode\": \"off\" } }
}
CONF
  chmod 700 ~/.openclaw
  chmod 600 ~/.openclaw/openclaw.json
  echo NEW_TOKEN: \$TOKEN
  echo FIX_B_DONE
"
```

**Important:** Record the newly generated token.

### Fix C — Service Not Installed

```bash
ssh openclaw@{TARGET_HOST} "
  export PATH=\$(npm prefix -g)/bin:\$PATH
  openclaw gateway install && echo SERVICE_INSTALLED
  systemctl --user daemon-reload
  systemctl --user enable openclaw-gateway
  systemctl --user start openclaw-gateway
  sleep 3
  systemctl --user status openclaw-gateway --no-pager
"
```

### Fix D — Permissions Error

```bash
ssh openclaw@{TARGET_HOST} "
  chmod 700 ~/.openclaw
  chmod 600 ~/.openclaw/openclaw.json
  chmod -R 600 ~/.openclaw/credentials/ 2>/dev/null || true
  chown -R openclaw:openclaw ~/.openclaw
  # Fix log dir if used
  sudo mkdir -p /var/log/openclaw
  sudo chown openclaw:openclaw /var/log/openclaw
  echo FIX_D_DONE
"
```

### Fix E — Port Conflict

```bash
ssh openclaw@{TARGET_HOST} "
  echo '=== Who is using port 18789? ==='
  ss -tlnp | grep 18789
  fuser 18789/tcp 2>/dev/null && echo 'PID found' || echo 'No PID via fuser'
  echo ''
  echo 'To kill conflicting process: fuser -k 18789/tcp'
  echo 'Or change OpenClaw port in openclaw.json gateway.port'
"
```

```bash
# Kill the conflicting process (confirm it's safe first)
ssh openclaw@{TARGET_HOST} "fuser -k 18789/tcp && echo KILLED || echo NOTHING_TO_KILL"
# Then restart gateway
ssh openclaw@{TARGET_HOST} "systemctl --user restart openclaw-gateway && sleep 3 && systemctl --user status openclaw-gateway --no-pager"
```

### Fix F — Node Modules Corrupt

```bash
ssh openclaw@{TARGET_HOST} "
  export PATH=\$(npm prefix -g)/bin:\$PATH
  # Reinstall global packages
  npm cache clean --force
  npm install -g openclaw@latest
  echo FIX_F_DONE
"
```

### Fix G — Config Syntax Error

```bash
ssh openclaw@{TARGET_HOST} "
  # Validate JSON syntax
  python3 -m json.tool ~/.openclaw/openclaw.json && echo JSON_VALID || echo JSON_INVALID
"
```

If invalid, show the file and fix the syntax:
```bash
ssh openclaw@{TARGET_HOST} "cat ~/.openclaw/openclaw.json"
```

**Common JSON5 vs JSON issue:** OpenClaw uses JSON5 format (supports comments, trailing commas). If in doubt, remove all comments and trailing commas to ensure valid JSON.

---

## [SC-2] Gateway Not Listening on Port

Service is active but `ss -tlnp | grep 18789` shows nothing.

```bash
ssh openclaw@{TARGET_HOST} "
  echo '=== Gateway Process Check ==='
  ps aux | grep -i '[o]penclaw\|[g]ateway'
  echo ''
  echo '=== All Listening TCP Ports ==='
  ss -tlnp
  echo ''
  echo '=== Recent Logs ==='
  journalctl --user -u openclaw-gateway -n 20 --no-pager
"
```

**Decision tree:**
- Process visible in `ps` but no port → Port binding may be taking time; wait 5s and retry
- `Error: EADDRINUSE` in logs → Port conflict (Fix E above)
- Gateway bound to wrong interface → Check `gateway.bind` in config (must be `loopback` or `127.0.0.1`)
- Process not visible in `ps` → Service crashed after start; check logs for panic/crash

**Check and fix bind address:**
```bash
ssh openclaw@{TARGET_HOST} "
  python3 -c \"
import json
with open('/home/openclaw/.openclaw/openclaw.json') as f:
    c = json.load(f)
print('bind:', c.get('gateway',{}).get('bind', 'NOT SET'))
print('port:', c.get('gateway',{}).get('port', 18789))
\"
"
```

---

## [SC-3] Gateway Unresponsive (Port Open, Health Failing)

```bash
ssh openclaw@{TARGET_HOST} "
  echo '=== Health Probe ==='
  curl -v http://127.0.0.1:18789/health 2>&1 | tail -20
  echo ''
  echo '=== Auth Test ==='
  curl -sf -H 'Authorization: Bearer {GATEWAY_TOKEN}' http://127.0.0.1:18789/health && echo AUTH_OK || echo AUTH_FAIL
  echo ''
  echo '=== Recent Logs ==='
  journalctl --user -u openclaw-gateway -n 30 --no-pager
"
```

**Decision tree:**
- `401 Unauthorized` → Token in request doesn't match config token; verify `{GATEWAY_TOKEN}`
- `Connection refused` despite ss showing port → Race condition; restart gateway
- Timeout → Process is hung; kill and restart
- `500 Internal Server Error` → Application error; check logs for stack trace

**Force restart:**
```bash
ssh openclaw@{TARGET_HOST} "
  systemctl --user restart openclaw-gateway
  sleep 5
  curl -sf -H 'Authorization: Bearer {GATEWAY_TOKEN}' http://127.0.0.1:18789/health && echo BACK_ONLINE || echo STILL_DOWN
"
```

---

## [SC-4] Docker Container Issues

### Full Docker Diagnostics

```bash
ssh openclaw@{TARGET_HOST} "
  echo '=== Container Status ==='
  docker compose -f ~/openclaw/docker-compose.yml ps 2>/dev/null || docker ps -a | grep openclaw
  echo ''
  echo '=== Container Logs (last 50 lines) ==='
  docker compose -f ~/openclaw/docker-compose.yml logs --tail=50 2>/dev/null || docker logs openclaw-gateway --tail=50 2>/dev/null
  echo ''
  echo '=== Docker System Info ==='
  docker system df
  echo ''
  echo '=== Docker Events (last 10 mins) ==='
  docker events --since=10m --until=now --filter container=openclaw-gateway 2>/dev/null | tail -10
"
```

**Decision tree:**

| Container State | Diagnosis | Fix |
|----------------|-----------|-----|
| `exited (1)` | Application crash | Check logs for error; fix config; restart |
| `restarting` | Crash loop | Check logs; likely config or missing env var |
| `exited (137)` | OOM killed | Increase host memory or container memory limit |
| `exited (143)` | Normal SIGTERM stop | Not an error; just restart |
| `Up X minutes` + health failing | App issue | Check app logs |

### Fix: Crash Loop (Container Keeps Restarting)

```bash
ssh openclaw@{TARGET_HOST} "
  # Stop the container first
  docker compose -f ~/openclaw/docker-compose.yml stop
  
  # Read logs with no restart interference
  docker compose -f ~/openclaw/docker-compose.yml logs --no-log-prefix 2>&1 | tail -50
"
```

Look for:
- `Cannot find module` → npm/build issue → Rebuild image
- `Invalid config` / JSON parse error → Fix openclaw.json
- `Permission denied on /home/node/.openclaw` → Fix volume ownership
- `EADDRINUSE` → Port conflict inside container (shouldn't happen; check .env port)

### Fix: OOM Killed

```bash
ssh {TARGET_USER}@{TARGET_HOST} "
  # Add/increase swap space
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  free -h && echo SWAP_DONE
"
```

### Fix: Volume Permission Error

```bash
ssh {TARGET_USER}@{TARGET_HOST} "
  # Containers run as uid 1000
  chown -R 1000:1000 /home/openclaw/.openclaw
  echo VOLUME_PERMS_FIXED
"
```

### Fix: Stale Lock File

```bash
ssh openclaw@{TARGET_HOST} "
  ls ~/.openclaw/gateway.*.lock 2>/dev/null && echo 'Lock files found' || echo 'No lock files'
  rm -f ~/.openclaw/gateway.*.lock
  docker compose -f ~/openclaw/docker-compose.yml restart
  echo LOCK_CLEARED
"
```

### Fix: Rebuild After Config Change

```bash
ssh openclaw@{TARGET_HOST} "
  cd ~/openclaw
  docker compose build 2>&1 | tail -20
  docker compose up -d
  sleep 10
  docker compose ps
  docker compose logs --tail=20
"
```

### Docker Network Debugging

```bash
ssh openclaw@{TARGET_HOST} "
  echo '=== Docker Networks ==='
  docker network ls | grep openclaw
  echo ''
  echo '=== Container Network Config ==='
  docker inspect openclaw-gateway --format '{{json .NetworkSettings.Networks}}' 2>/dev/null | python3 -m json.tool || echo 'Container not found'
  echo ''
  echo '=== Port Bindings ==='
  docker inspect openclaw-gateway --format '{{json .NetworkSettings.Ports}}' 2>/dev/null | python3 -m json.tool || echo 'Container not found'
"
```

---

## [SC-5] Disk Space Full

```bash
ssh {TARGET_USER}@{TARGET_HOST} "
  echo '=== Disk Usage ==='
  df -h
  echo ''
  echo '=== Top Disk Consumers ==='
  du -sh /var/log/* 2>/dev/null | sort -hr | head -10
  du -sh /home/openclaw/.openclaw/agents/*/sessions/ 2>/dev/null | sort -hr | head -10
  du -sh /home/openclaw/.openclaw/workspace/ 2>/dev/null
  du -sh /var/lib/docker/ 2>/dev/null
  echo '=== Docker Image/Container Usage ==='
  docker system df 2>/dev/null || echo 'Docker not installed'
"
```

**Cleanup actions (in order of safety):**

```bash
# 1. Clean apt cache (safe)
ssh {TARGET_USER}@{TARGET_HOST} "apt-get clean && echo APT_CLEANED"

# 2. Clean old journal logs (safe)
ssh {TARGET_USER}@{TARGET_HOST} "journalctl --vacuum-time=7d && echo JOURNAL_CLEANED"

# 3. Remove old session transcripts (> 30 days old) — REVIEW BEFORE RUNNING
ssh openclaw@{TARGET_HOST} "
  echo '=== Old sessions to be cleaned (preview) ==='
  find ~/.openclaw/agents/*/sessions/ -name '*.jsonl' -mtime +30 -ls 2>/dev/null | head -20
  echo '=== Run next command to actually delete ==='
"
# If confirmed safe:
ssh openclaw@{TARGET_HOST} "find ~/.openclaw/agents/*/sessions/ -name '*.jsonl' -mtime +30 -delete && echo SESSIONS_CLEANED"

# 4. Docker cleanup (safe to remove unused images/containers)
ssh {TARGET_USER}@{TARGET_HOST} "docker system prune -f && echo DOCKER_PRUNED"

# 5. Remove old log files
ssh {TARGET_USER}@{TARGET_HOST} "find /var/log -name '*.log.gz' -mtime +14 -delete && find /var/log -name '*.log.1' -mtime +7 -delete && echo LOGS_CLEANED"
```

---

## [SC-6] Memory Pressure

```bash
ssh {TARGET_USER}@{TARGET_HOST} "
  echo '=== Memory Overview ==='
  free -h
  echo ''
  echo '=== Top Memory Consumers ==='
  ps aux --sort=-%mem | head -15
  echo ''
  echo '=== OpenClaw Process Memory ==='
  ps aux | grep -i '[o]penclaw\|[n]ode' | awk '{print \$2, \$4, \$11}'
"
```

**Decision tree:**
- OpenClaw using >500MB → Investigate session accumulation; restart gateway
- System memory < 200MB free with no swap → Add swap (see SC-4 OOM fix)
- Other processes consuming memory → Investigate; may need larger VPS plan

**Graceful restart to reclaim memory:**
```bash
ssh openclaw@{TARGET_HOST} "
  # Native
  systemctl --user restart openclaw-gateway
  sleep 5
  free -h
"
```

---

## [SC-7] Channel Issues (Bot Silent / Not Responding)

### Diagnostics

```bash
ssh openclaw@{TARGET_HOST} "
  export PATH=\$(npm prefix -g)/bin:\$PATH
  echo '=== Gateway Status ==='
  openclaw status --all 2>/dev/null | grep -A 20 'channels' || echo 'Cannot run openclaw status'
  echo ''
  echo '=== Channel Config ==='
  python3 -c \"
import json
with open('/home/openclaw/.openclaw/openclaw.json') as f:
    c = json.load(f)
channels = c.get('channels', {})
for ch, cfg in channels.items():
    token = cfg.get('botToken', cfg.get('token', 'NOT SET'))
    print(f'{ch}: enabled={cfg.get(\"enabled\")}, dmPolicy={cfg.get(\"dmPolicy\")}, token={token[:8]}...')
\" 2>/dev/null || echo 'Config parse failed'
  echo ''
  echo '=== Recent Channel Errors in Logs ==='
  journalctl --user -u openclaw-gateway -n 100 --no-pager 2>/dev/null | grep -i 'telegram\|discord\|whatsapp\|channel\|webhook' | tail -20
"
```

**Decision tree:**

| Finding | Fix |
|---------|-----|
| Bot token shows `NOT SET` | Add bot token to config |
| `401 Unauthorized` in logs | Bot token invalid/revoked; regenerate |
| `webhook` errors | Telegram webhook may be stale; reset it |
| `dmPolicy: disabled` | Re-enable DM policy |
| Pairing required but no requests visible | Bot may be receiving messages; check pairing list |
| WhatsApp session expired | Re-link WhatsApp account |

### Fix: Re-authenticate Channel

```bash
# Telegram — update token
ssh openclaw@{TARGET_HOST} "
  export PATH=\$(npm prefix -g)/bin:\$PATH
  openclaw config set channels.telegram.botToken '{NEW_BOT_TOKEN}'
  openclaw gateway restart
  echo TELEGRAM_UPDATED
"

# Telegram — test token validity directly
ssh openclaw@{TARGET_HOST} "
  TOKEN=\$(python3 -c \"import json; c=json.load(open('/home/openclaw/.openclaw/openclaw.json')); print(c['channels']['telegram']['botToken'])\" 2>/dev/null)
  curl -sf \"https://api.telegram.org/bot\${TOKEN}/getMe\" | python3 -m json.tool
"
```

### Fix: Pending Pairing Requests

```bash
ssh openclaw@{TARGET_HOST} "
  export PATH=\$(npm prefix -g)/bin:\$PATH
  openclaw pairing list telegram 2>/dev/null
  # To approve a request:
  # openclaw pairing approve telegram <CODE>
"
```

---

## [SC-8] Permission Problems

```bash
ssh openclaw@{TARGET_HOST} "
  echo '=== .openclaw directory permissions ==='
  ls -la ~/.openclaw/
  ls -la ~/.openclaw/openclaw.json 2>/dev/null || echo 'Config missing'
  ls -la ~/.openclaw/credentials/ 2>/dev/null || echo 'No credentials dir'
  echo ''
  echo '=== Owner Check ==='
  stat -c '%U:%G %a %n' ~/.openclaw ~/.openclaw/openclaw.json 2>/dev/null
"
```

**Fix all permissions at once:**
```bash
ssh {TARGET_USER}@{TARGET_HOST} "
  chown -R openclaw:openclaw /home/openclaw/.openclaw
  chmod 700 /home/openclaw/.openclaw
  chmod 600 /home/openclaw/.openclaw/openclaw.json
  find /home/openclaw/.openclaw/credentials/ -type f -exec chmod 600 {} \; 2>/dev/null || true
  find /home/openclaw/.openclaw/credentials/ -type d -exec chmod 700 {} \; 2>/dev/null || true
  echo PERMISSIONS_FIXED
"
```

---

## [SC-9] Config / Logic Issues

### Validate Entire Config

```bash
ssh openclaw@{TARGET_HOST} "
  export PATH=\$(npm prefix -g)/bin:\$PATH
  openclaw doctor 2>&1 && echo DOCTOR_OK || echo DOCTOR_ISSUES
"
```

### Show Config (Redacted)

```bash
ssh openclaw@{TARGET_HOST} "
  export PATH=\$(npm prefix -g)/bin:\$PATH
  openclaw config get 2>/dev/null | grep -v token | grep -v password | grep -v botToken
"
```

### Common Config Fixes

```bash
# Fix: mDNS broadcasting on VPS (security issue)
ssh openclaw@{TARGET_HOST} "
  export PATH=\$(npm prefix -g)/bin:\$PATH
  openclaw config set discovery.mdns.mode off
  openclaw gateway restart
  echo MDNS_DISABLED
"

# Fix: Gateway binding to wrong interface
ssh openclaw@{TARGET_HOST} "
  export PATH=\$(npm prefix -g)/bin:\$PATH
  openclaw config set gateway.bind loopback
  openclaw gateway restart
  echo BIND_FIXED
"

# Fix: dmScope not set (cross-user leakage risk)
ssh openclaw@{TARGET_HOST} "
  export PATH=\$(npm prefix -g)/bin:\$PATH
  openclaw config set session.dmScope per-channel-peer
  openclaw gateway restart
  echo DMSCOPE_FIXED
"
```

---

## Escalation Procedures

If none of the above resolve the issue, escalate with a collected diagnostic bundle:

### Collect Diagnostic Bundle

```bash
ssh openclaw@{TARGET_HOST} "
  echo '====== OPENCLAW DIAGNOSTIC BUNDLE ======'
  echo 'Timestamp:' \$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo 'Hostname:' \$(hostname)
  echo ''
  echo '--- OS Info ---'
  uname -a
  cat /etc/os-release | grep -E 'NAME|VERSION'
  echo ''
  echo '--- Node.js & npm ---'
  node --version 2>/dev/null; npm --version 2>/dev/null
  echo ''
  echo '--- OpenClaw Version ---'
  export PATH=\$(npm prefix -g)/bin:\$PATH
  openclaw --version 2>/dev/null || echo 'not found'
  echo ''
  echo '--- Service Status ---'
  systemctl --user status openclaw-gateway --no-pager 2>/dev/null || docker ps 2>/dev/null
  echo ''
  echo '--- Last 100 Log Lines ---'
  journalctl --user -u openclaw-gateway -n 100 --no-pager 2>/dev/null || docker compose -f ~/openclaw/docker-compose.yml logs --tail=100 2>/dev/null
  echo ''
  echo '--- Config (Redacted) ---'
  openclaw config get 2>/dev/null | grep -v -E 'token|password|botToken|apiKey' || cat ~/.openclaw/openclaw.json | grep -v -E 'token|password|botToken|apiKey'
  echo ''
  echo '--- Disk & Memory ---'
  df -h && free -h
  echo ''
  echo '--- Listening Ports ---'
  ss -tlnp
  echo '====== END BUNDLE ======'
" 2>&1
```

**Escalation channels:**
- Discord community: `https://discord.gg/clawd`
- Security issues only: `security@openclaw.ai`
- Include the diagnostic bundle (redact any tokens before sharing)

---

## Post-Fix Verification

After any fix, always run the full health check:

```bash
ssh openclaw@{TARGET_HOST} "
  echo '=== POST-FIX VERIFICATION ==='
  echo -n 'Service: '
  systemctl --user is-active openclaw-gateway 2>/dev/null || docker inspect openclaw-gateway --format '{{.State.Status}}' 2>/dev/null || echo UNKNOWN
  echo -n 'Health: '
  curl -sf -H 'Authorization: Bearer {GATEWAY_TOKEN}' http://127.0.0.1:18789/health > /dev/null && echo OK || echo FAIL
  echo -n 'Port 18789: '
  ss -tlnp | grep 18789 | grep -q '127.0.0.1' && echo LOOPBACK_ONLY || (ss -tlnp | grep 18789 || echo NOT_LISTENING)
  echo -n 'Config valid: '
  python3 -m json.tool ~/.openclaw/openclaw.json > /dev/null && echo OK || echo INVALID_JSON
  echo '=== END VERIFICATION ==='
"
```
