---
name: openclaw-vps-install
version: 2.0.0
description: Clawdfather-native VPS deployment playbook for OpenClaw. Executes directly via SSH — no Ansible required. Covers native Linux install and Docker variants with health checks and rollback guidance.
author: clawdfather
---

# OpenClaw VPS Install — Clawdfather Playbook

Step-by-step executable playbook. Each phase contains a script or inline command block. Execute phases in order.

## Security Defaults

All installs enforce these from the start:

- **Loopback bind** — gateway listens on 127.0.0.1 only (SSH tunnel for access)
- **Token auth** — 32+ char hex token required (`openssl rand -hex 32`)
- **mDNS off** — no network discovery broadcasting
- **Elevated tools disabled** — `tools.elevated.enabled = false`
- **DM scope** — `per-channel-peer` (no cross-user session leakage)
- **UFW + fail2ban** — deny all incoming except SSH, brute-force protection

---

## Prerequisites

- `TARGET_HOST` — VPS IP or hostname
- `SSH_KEY` — path to SSH private key (key-based auth only)
- `VARIANT` — `native` or `docker`
- `GATEWAY_TOKEN` — (optional) pre-generated 32-char hex; scripts auto-generate if omitted
- `TELEGRAM_BOT_TOKEN` — (optional) for channel setup

## Variant Selection

| Criterion | Native | Docker |
|-----------|--------|--------|
| Minimal footprint, fastest setup | ✅ | |
| Reproducible builds, easy rollback | | ✅ |
| Binary dependencies (ffmpeg, etc.) | | ✅ |
| Container-level isolation | | ✅ |
| Single VPS, simple operations | ✅ | |

---

## Phase 0: Connectivity Check

```bash
ssh -o ConnectTimeout=10 root@HOST "echo CONNECTED && uname -a && id"
```

- `CONNECTED` → proceed
- `Connection refused` → check IP / VPS status
- `Permission denied (publickey)` → verify SSH key
- `Connection timed out` → open port 22 in cloud security group

---

## Phase 1: Prepare System

```bash
bash scripts/vps-install-prep.sh root@HOST
```

Updates packages, installs curl/git/ca-certificates/ufw/fail2ban, creates `openclaw` user, copies SSH keys, configures passwordless sudo for service management.

---

## Phase 2: Install Node.js 22

```bash
ssh root@HOST '
  node_ver=$(node --version 2>/dev/null | cut -c2- | cut -d. -f1)
  if [ "${node_ver:-0}" -ge 22 ]; then
    echo "NODEJS_OK_ALREADY"
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
  node --version && npm --version
'
```

---

## Phase 3A: Native Install

```bash
bash scripts/vps-install-native.sh openclaw@HOST [TOKEN]
```

- Token auto-generated if omitted — **save the printed token**
- Installs openclaw binary, writes secure config, sets up systemd service
- Check output for `[DONE]` / `[WARN]` prefixes

---

## Phase 3B: Docker Install

```bash
bash scripts/vps-install-docker.sh root@HOST openclaw@HOST [TOKEN]
```

- Installs Docker, clones repo, writes `.env`, builds image, creates systemd wrapper
- Token auto-generated if omitted — **save the printed token**

---

## Phase 4: Firewall

```bash
bash scripts/vps-firewall.sh root@HOST
```

Configures UFW (deny all, allow SSH only) and enables fail2ban. Port 18789 is NOT opened — access only via SSH tunnel.

---

## Phase 5: Validate

```bash
bash scripts/vps-health-check.sh openclaw@HOST TOKEN
```

Checks: service running, `/health` endpoint, port 18789 loopback-only, file permissions (700/.openclaw, 600/openclaw.json), `openclaw doctor`.

---

## Phase 6: SSH Tunnel Access

The gateway binds to loopback — access via SSH tunnel:

```bash
ssh -N -L 18789:127.0.0.1:18789 openclaw@HOST
# Then open: http://127.0.0.1:18789/
```

**macOS persistent tunnel** — save to `~/Library/LaunchAgents/openclaw-tunnel.plist`:

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
        <string>openclaw@HOST</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

---

## Channel Setup

```bash
ssh openclaw@HOST '
  export PATH=$(npm prefix -g)/bin:$PATH
  openclaw config set channels.telegram.enabled true
  openclaw config set channels.telegram.botToken "BOT_TOKEN"
  openclaw config set channels.telegram.dmPolicy pairing
  openclaw gateway restart
'
```

---

## Rollback

**Native:** `npm i -g openclaw@PREVIOUS_VERSION && openclaw gateway restart`

**Docker:** `cd ~/openclaw && git checkout PREVIOUS_TAG && docker compose build && docker compose up -d`

---

## Quick Reference

| Variable | Description | Example |
|----------|-------------|---------|
| `TARGET_HOST` | VPS IP or hostname | `1.2.3.4` |
| `GATEWAY_TOKEN` | 32-hex-char auth token | `$(openssl rand -hex 32)` |
| `VARIANT` | Install type | `native` or `docker` |
| `PREVIOUS_VERSION` | For rollback | `1.2.3` |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | `123456:ABCdef...` |
