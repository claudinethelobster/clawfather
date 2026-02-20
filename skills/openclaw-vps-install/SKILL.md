---
name: openclaw-vps-install
version: 2.0.0
description: Clawdfather-native VPS deployment playbook for OpenClaw. Executes directly via SSH — no Ansible required. Covers native Linux install and Docker variants with health checks and rollback guidance.
author: clawdfather
---

# OpenClaw VPS Install — Clawdfather Playbook

This skill is a **step-by-step executable playbook** for clawdfather. Each phase contains SSH command chains, expected outputs, and decision logic. Execute phases in order. Do not skip phases.

---

## Prerequisites

Before starting, collect:
- `TARGET_HOST` — VPS IP address or hostname
- `TARGET_USER` — SSH user (usually `root` for initial setup)
- `SSH_KEY` — Path to SSH private key
- `VARIANT` — `native` or `docker`
- `GATEWAY_TOKEN` — Pre-generated 32-char hex (generate with `openssl rand -hex 32`)
- `TELEGRAM_BOT_TOKEN` — (Optional) Telegram bot token if channel is needed now

**Choose your variant:**

| Criterion | Choose Native | Choose Docker |
|-----------|--------------|---------------|
| Minimal footprint, fastest setup | ✅ | |
| Systemd service management | ✅ | ✅ (wrapped) |
| Reproducible builds, easy rollback | | ✅ |
| Binary dependencies (ffmpeg, etc.) | | ✅ (bake into image) |
| Container-level gateway isolation | | ✅ |
| Single VPS, simple operations | ✅ | |

---

## Phase 0: Connectivity Check

**Purpose:** Confirm SSH access before doing anything.

```bash
# SSH probe — should return immediately
ssh -o ConnectTimeout=10 -o BatchMode=yes {TARGET_USER}@{TARGET_HOST} "echo CONNECTED && uname -a && id && free -h && df -h /"
```

**Expected output:**
```
CONNECTED
Linux hostname 5.x.x ... #1 SMP ...
uid=0(root) gid=0(root) groups=0(root)
              total        used        free
Mem:           3.8Gi       ...
Filesystem      Size  Used Avail Use% Mounted on
/dev/...         40G    5G   33G  14% /
```

**Decision tree:**
- `CONNECTED` in output → ✅ Proceed to Phase 1
- `Connection refused` → ❌ VPS is not reachable. Check IP, check firewall, check VPS status in provider console
- `Permission denied (publickey)` → ❌ SSH key not accepted. Verify `SSH_KEY` path, confirm key is authorized on server
- `Connection timed out` → ❌ Provider firewall blocking SSH. Open port 22 in cloud security group

---

## Phase 1: System Preparation

**Purpose:** Update packages, install base dependencies, create the openclaw user.

### 1a — System Update

```bash
ssh {TARGET_USER}@{TARGET_HOST} "apt-get update -qq && apt-get upgrade -y && echo UPDATE_DONE"
```

**Expected:** `UPDATE_DONE` at end of output  
**On failure:** Note error; if lock error (`Could not get lock`), wait 60s and retry once

### 1b — Install Base Dependencies

```bash
ssh {TARGET_USER}@{TARGET_HOST} "apt-get install -y curl git ca-certificates ufw fail2ban && echo DEPS_DONE"
```

**Expected:** `DEPS_DONE`  
**On failure:** Check apt errors in output; if package not found, run `apt-get update` first

### 1c — Create OpenClaw User

```bash
ssh {TARGET_USER}@{TARGET_HOST} "
  id openclaw &>/dev/null && echo 'USER_EXISTS' || (
    useradd -m -s /bin/bash -d /home/openclaw openclaw && echo 'USER_CREATED'
  )
  # Verify
  id openclaw && ls -la /home/openclaw
"
```

**Expected:** `USER_CREATED` or `USER_EXISTS`, plus user info line  
**On failure:** Check if home directory issue; try `useradd -m -s /bin/bash openclaw`

### 1d — Copy SSH Key for openclaw User

```bash
ssh {TARGET_USER}@{TARGET_HOST} "
  mkdir -p /home/openclaw/.ssh
  cp /root/.ssh/authorized_keys /home/openclaw/.ssh/authorized_keys 2>/dev/null || true
  chown -R openclaw:openclaw /home/openclaw/.ssh
  chmod 700 /home/openclaw/.ssh
  chmod 600 /home/openclaw/.ssh/authorized_keys
  echo SSH_KEY_DONE
"
```

**Expected:** `SSH_KEY_DONE`

### Phase 1 Checkpoint

```bash
ssh {TARGET_USER}@{TARGET_HOST} "echo --- && id openclaw && ls /home/openclaw && echo P1_OK"
```

**Expected:** `P1_OK` — if not, review errors above before continuing

---

## Phase 2: Install Node.js 22

```bash
ssh {TARGET_USER}@{TARGET_HOST} "
  # Check if Node.js 22+ already installed
  node_ver=\$(node --version 2>/dev/null | cut -c2- | cut -d. -f1)
  if [ \"\${node_ver:-0}\" -ge 22 ]; then
    echo 'NODEJS_OK_ALREADY'
  else
    echo 'Installing Node.js 22...'
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
    echo NODEJS_INSTALLED
  fi
  node --version && npm --version && echo NODEJS_DONE
"
```

**Expected output:**
```
NODEJS_OK_ALREADY   (or NODEJS_INSTALLED)
v22.x.x
10.x.x
NODEJS_DONE
```

**Decision tree:**
- `NODEJS_DONE` present → ✅ Continue
- `v20.x.x` reported → ❌ Version too old. Re-run NodeSource setup script
- `command not found` after install → ❌ Try `hash -r` then verify; check `/usr/bin/node` exists
- curl fails (no internet) → ❌ Check VPS outbound internet access

---

## Phase 3A (Native): Install OpenClaw

*Skip to Phase 3B for Docker variant.*

### 3A-1 — Run Installer as openclaw User

```bash
ssh {TARGET_USER}@{TARGET_HOST} "sudo -u openclaw bash -c 'curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard && echo INSTALL_DONE'"
```

**Expected:** `INSTALL_DONE`  
**On failure:**
- `not found` / npm errors → Check Node.js version first; ensure npm is accessible
- Permission errors → Verify openclaw user's home exists and is writable
- `--no-onboard flag not supported` → Try `curl -fsSL https://openclaw.ai/install.sh | bash` and skip interactive prompts manually

### 3A-2 — Verify Install

```bash
ssh openclaw@{TARGET_HOST} "
  export PATH=\$(npm prefix -g)/bin:\$PATH
  which openclaw && openclaw --version && echo OPENCLAW_OK
"
```

**Expected:** Path to openclaw binary + version string + `OPENCLAW_OK`  
**On failure (not found):**
```bash
ssh openclaw@{TARGET_HOST} "
  npm prefix -g
  ls \$(npm prefix -g)/bin/ | grep openclaw
  echo PATH_IS: \$PATH
"
```
Then add the correct path to `~/.bashrc` for the openclaw user.

### 3A-3 — Write Secure Config

```bash
ssh openclaw@{TARGET_HOST} "
  mkdir -p ~/.openclaw
  cat > ~/.openclaw/openclaw.json << 'CONF'
{
  \"gateway\": {
    \"mode\": \"local\",
    \"bind\": \"loopback\",
    \"port\": 18789,
    \"auth\": { \"mode\": \"token\", \"token\": \"{GATEWAY_TOKEN}\" }
  },
  \"session\": { \"dmScope\": \"per-channel-peer\" },
  \"tools\": {
    \"deny\": [\"gateway\", \"cron\", \"sessions_spawn\", \"sessions_send\"],
    \"exec\": { \"security\": \"ask\", \"ask\": \"always\" },
    \"elevated\": { \"enabled\": false },
    \"fs\": { \"workspaceOnly\": true }
  },
  \"discovery\": { \"mdns\": { \"mode\": \"off\" } },
  \"logging\": {
    \"file\": \"/var/log/openclaw/openclaw.log\",
    \"level\": \"info\",
    \"redactSensitive\": \"tools\"
  }
}
CONF
  chmod 700 ~/.openclaw
  chmod 600 ~/.openclaw/openclaw.json
  echo CONFIG_WRITTEN
"
```

**Expected:** `CONFIG_WRITTEN`  
**After writing:** Run `openclaw doctor` to validate — see Phase 5

### 3A-4 — Install Systemd Service

```bash
ssh openclaw@{TARGET_HOST} "
  export PATH=\$(npm prefix -g)/bin:\$PATH

  # Ensure log dir exists
  sudo mkdir -p /var/log/openclaw
  sudo chown openclaw:openclaw /var/log/openclaw

  # Install systemd user service
  openclaw gateway install && echo SERVICE_INSTALLED
"
```

**Expected:** `SERVICE_INSTALLED`

```bash
# Enable lingering so service survives logout
ssh {TARGET_USER}@{TARGET_HOST} "loginctl enable-linger openclaw && echo LINGER_ENABLED"
```

```bash
# Start and enable the service
ssh openclaw@{TARGET_HOST} "
  systemctl --user daemon-reload
  systemctl --user enable openclaw-gateway
  systemctl --user start openclaw-gateway
  sleep 3
  systemctl --user status openclaw-gateway --no-pager && echo SERVICE_STARTED
"
```

**Expected:** Active (running) state + `SERVICE_STARTED`  
**On failure:** Check `journalctl --user -u openclaw-gateway -n 30` for error details

---

## Phase 3B (Docker): Install OpenClaw via Docker

*This section is for the Docker variant.*

### 3B-1 — Install Docker Engine

```bash
ssh {TARGET_USER}@{TARGET_HOST} "
  docker --version &>/dev/null && echo 'DOCKER_EXISTS' || (
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
    echo DOCKER_INSTALLED
  )
  docker --version && echo DOCKER_DONE
"
```

**Expected:** `DOCKER_DONE` + version string  
**On failure:** Check `systemctl status docker` and system logs

### 3B-2 — Add openclaw User to Docker Group

```bash
ssh {TARGET_USER}@{TARGET_HOST} "
  usermod -aG docker openclaw
  echo DOCKER_GROUP_DONE
"
```

### 3B-3 — Clone OpenClaw Repo

```bash
ssh openclaw@{TARGET_HOST} "
  git clone https://github.com/openclaw/openclaw.git ~/openclaw 2>&1 || \
    (cd ~/openclaw && git pull && echo REPO_UPDATED)
  ls ~/openclaw && echo REPO_DONE
"
```

**Expected:** `REPO_DONE` + file listing

### 3B-4 — Write .env File

```bash
ssh openclaw@{TARGET_HOST} "
  cat > ~/openclaw/.env << 'ENV'
OPENCLAW_IMAGE=openclaw:local
OPENCLAW_GATEWAY_TOKEN={GATEWAY_TOKEN}
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_CONFIG_DIR=/home/openclaw/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/openclaw/.openclaw/workspace
ENV
  chmod 600 ~/openclaw/.env
  echo ENV_WRITTEN
"
```

**Expected:** `ENV_WRITTEN`

### 3B-5 — Build Docker Image

```bash
ssh openclaw@{TARGET_HOST} "
  cd ~/openclaw
  docker compose build 2>&1 | tail -20
  echo BUILD_DONE
"
```

**Expected:** `BUILD_DONE` (build may take 5-15 minutes on first run)  
**On failure:** 
- `permission denied` → Re-login to pick up docker group: `newgrp docker`
- Build errors → Check Dockerfile and network; ensure internet access
- OOM during build → VPS needs at least 2GB RAM; use a swap file if needed

### 3B-6 — Create Systemd Wrapper for Docker Compose

```bash
ssh {TARGET_USER}@{TARGET_HOST} "
cat > /etc/systemd/system/openclaw-docker.service << 'SVC'
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
  systemctl daemon-reload
  systemctl enable openclaw-docker.service
  systemctl start openclaw-docker.service
  sleep 5
  systemctl status openclaw-docker.service --no-pager && echo DOCKER_SERVICE_STARTED
"
```

**Expected:** `DOCKER_SERVICE_STARTED`

```bash
# Verify container is running
ssh openclaw@{TARGET_HOST} "
  docker compose -f ~/openclaw/docker-compose.yml ps
  docker compose -f ~/openclaw/docker-compose.yml logs --tail=20
"
```

---

## Phase 4: Firewall Setup (Both Variants)

```bash
ssh {TARGET_USER}@{TARGET_HOST} "
  # Configure UFW
  ufw --force reset
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow ssh comment 'SSH access'
  # Port 18789 is NOT opened — access only via SSH tunnel
  echo 'y' | ufw enable
  ufw status verbose && echo UFW_DONE
"
```

**Expected output includes:**
```
Status: active
To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere
UFW_DONE
```

**Verify only port 22 is open:**
```bash
ssh {TARGET_USER}@{TARGET_HOST} "ss -tlnp | grep -v '127.0.0.1' && echo PORT_CHECK_DONE"
```

Port 18789 should NOT appear bound to `0.0.0.0` — only loopback is acceptable.

**Enable fail2ban (brute-force SSH protection):**
```bash
ssh {TARGET_USER}@{TARGET_HOST} "
  systemctl enable fail2ban
  systemctl start fail2ban
  fail2ban-client status && echo FAIL2BAN_DONE
"
```

---

## Phase 5: Health Checks & Validation

Run all checks. All must pass before declaring install complete.

### Check 1 — Service Status

**Native:**
```bash
ssh openclaw@{TARGET_HOST} "
  systemctl --user status openclaw-gateway --no-pager
  echo STATUS_CHECK: \$?
"
```

**Docker:**
```bash
ssh openclaw@{TARGET_HOST} "
  docker compose -f ~/openclaw/docker-compose.yml ps
  docker inspect openclaw-gateway --format '{{.State.Status}}' 2>/dev/null
"
```

**Pass condition:** Service/container shows `running` or `active (running)`

### Check 2 — Gateway Health Ping

```bash
ssh openclaw@{TARGET_HOST} "
  curl -sf -H 'Authorization: Bearer {GATEWAY_TOKEN}' http://127.0.0.1:18789/health 2>&1
  echo HEALTH_CURL_EXIT: \$?
"
```

**Expected:** JSON response with `\"status\":\"ok\"` (or similar) + `HEALTH_CURL_EXIT: 0`  
**Failure:** Gateway not listening — check logs (Step 6)

### Check 3 — Log Output Check

**Native:**
```bash
ssh openclaw@{TARGET_HOST} "journalctl --user -u openclaw-gateway -n 30 --no-pager"
```

**Docker:**
```bash
ssh openclaw@{TARGET_HOST} "docker compose -f ~/openclaw/docker-compose.yml logs --tail=30"
```

**Look for:**
- ✅ `[gateway] listening on ws://127.0.0.1:18789` or similar startup message
- ❌ `EADDRINUSE` — port in use by another process
- ❌ `ENOENT` — config file missing
- ❌ `Invalid token` — token format issue in config
- ❌ `Error: EACCES` — permission denied on config or log file

### Check 4 — File Permissions

```bash
ssh openclaw@{TARGET_HOST} "
  stat -c '%a %U' ~/.openclaw && \
  stat -c '%a %U' ~/.openclaw/openclaw.json && \
  echo PERMISSIONS_DONE
"
```

**Expected:**
```
700 openclaw
600 openclaw
PERMISSIONS_DONE
```

If wrong, fix with:
```bash
ssh openclaw@{TARGET_HOST} "chmod 700 ~/.openclaw && chmod 600 ~/.openclaw/openclaw.json"
```

### Check 5 — OpenClaw Doctor

**Native:**
```bash
ssh openclaw@{TARGET_HOST} "
  export PATH=\$(npm prefix -g)/bin:\$PATH
  openclaw doctor 2>&1 && echo DOCTOR_DONE
"
```

**Docker:**
```bash
ssh openclaw@{TARGET_HOST} "
  docker compose -f ~/openclaw/docker-compose.yml run --rm openclaw-cli doctor 2>&1
"
```

**Expected:** No errors. Warnings are OK. `DOCTOR_DONE` or clean exit.

### Check 6 — External Port Exposure

```bash
ssh {TARGET_USER}@{TARGET_HOST} "
  echo '=== Listening ports (non-loopback) ==='
  ss -tlnp | grep -v '127.0.0.1' | grep -v '::1'
  echo '=== UFW Status ==='
  ufw status
"
```

**Pass condition:**
- Port 18789 does NOT appear in `ss` output bound to `0.0.0.0`
- UFW shows only SSH allowed

### Final Validation Summary

```bash
ssh openclaw@{TARGET_HOST} "
  echo '=== INSTALL VALIDATION SUMMARY ==='
  echo -n 'Service running: '
  systemctl --user is-active openclaw-gateway 2>/dev/null || \
    docker inspect openclaw-gateway --format '{{.State.Status}}' 2>/dev/null || echo UNKNOWN
  echo -n 'Gateway health: '
  curl -sf -H 'Authorization: Bearer {GATEWAY_TOKEN}' http://127.0.0.1:18789/health > /dev/null && echo OK || echo FAIL
  echo -n 'Config permissions: '
  [ \"\$(stat -c '%a' ~/.openclaw/openclaw.json)\" = '600' ] && echo OK || echo FAIL
  echo -n 'UFW active: '
  ufw status | grep -q 'Status: active' && echo OK || echo FAIL
  echo '=== END SUMMARY ==='
"
```

---

## Phase 6: Post-Install Configuration

### Set Up SSH Tunnel Access (From Your Local Machine)

The gateway binds to loopback — access it through an SSH tunnel:

```bash
# One-time: create the tunnel
ssh -N -L 18789:127.0.0.1:18789 openclaw@{TARGET_HOST}

# Then open: http://127.0.0.1:18789/
# Enter gateway token: {GATEWAY_TOKEN}
```

**macOS persistent tunnel** (`~/Library/LaunchAgents/openclaw-tunnel.plist`):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>openclaw.ssh-tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/ssh</string>
        <string>-N</string>
        <string>-o</string>
        <string>ServerAliveInterval=60</string>
        <string>-o</string>
        <string>ExitOnForwardFailure=yes</string>
        <string>-L</string>
        <string>18789:127.0.0.1:18789</string>
        <string>openclaw@{TARGET_HOST}</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

### Connect Your First Channel

```bash
# Telegram — run on server
ssh openclaw@{TARGET_HOST} "
  export PATH=\$(npm prefix -g)/bin:\$PATH
  openclaw config set channels.telegram.enabled true
  openclaw config set channels.telegram.botToken '{TELEGRAM_BOT_TOKEN}'
  openclaw config set channels.telegram.dmPolicy pairing
  openclaw gateway restart
  echo CHANNEL_CONFIGURED
"
```

---

## Rollback Procedures

### Native — Roll Back to Previous Version

```bash
ssh openclaw@{TARGET_HOST} "
  export PATH=\$(npm prefix -g)/bin:\$PATH
  openclaw gateway stop
  npm i -g openclaw@{PREVIOUS_VERSION}
  openclaw doctor
  openclaw gateway start
  sleep 5
  openclaw health && echo ROLLBACK_OK || echo ROLLBACK_FAILED
"
```

### Docker — Roll Back to Previous Image

```bash
ssh openclaw@{TARGET_HOST} "
  cd ~/openclaw
  docker compose stop openclaw-gateway
  git checkout {PREVIOUS_TAG}  # or: git stash
  docker compose build
  docker compose up -d openclaw-gateway
  sleep 10
  docker compose logs --tail=20
"
```

### Full Reinstall (Last Resort)

```bash
# Stop everything
ssh openclaw@{TARGET_HOST} "
  systemctl --user stop openclaw-gateway 2>/dev/null
  docker compose -f ~/openclaw/docker-compose.yml stop 2>/dev/null
  
  # Back up config first!
  cp ~/.openclaw/openclaw.json /tmp/openclaw.json.bak
  cp -r ~/.openclaw/credentials/ /tmp/openclaw-creds-bak/
"

# Then restart from Phase 3
```

---

## Quick Reference: Key Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `TARGET_HOST` | VPS IP or hostname | `1.2.3.4` |
| `TARGET_USER` | SSH user for setup | `root` |
| `GATEWAY_TOKEN` | 32-hex-char auth token | `$(openssl rand -hex 32)` |
| `VARIANT` | Install type | `native` or `docker` |
| `PREVIOUS_VERSION` | For rollback | `1.2.3` |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | `123456:ABCdef...` |
