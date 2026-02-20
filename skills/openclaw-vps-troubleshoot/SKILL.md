---
name: openclaw-vps-troubleshoot
version: 2.0.0
description: Clawdfather-native VPS troubleshooting playbook for OpenClaw. Executes directly via SSH — collects diagnostics, diagnoses root causes, and applies targeted fixes. Covers native and Docker variants.
author: clawdfather
---

# OpenClaw VPS Troubleshoot — Clawdfather Playbook

Diagnosis-first, fix-second. Always collect diagnostics before applying fixes.

## Security Defaults

Verify these are intact during any troubleshooting:

- **Loopback bind** — gateway listens on 127.0.0.1 only
- **Token auth** — 32+ char hex token required
- **mDNS off** — no network discovery
- **Elevated tools disabled** — `tools.elevated.enabled = false`
- **DM scope** — `per-channel-peer`
- **UFW + fail2ban** — deny all incoming except SSH

---

## Triage

```bash
bash scripts/vps-triage.sh openclaw@HOST
```

Read the output and match to a symptom class:

| Symptom | Go To |
|---------|-------|
| Service `failed` or `inactive` | [SC-1] Service Won't Start |
| Service `active` but port not listening | [SC-2] Gateway Not Listening |
| Port listening but health check fails | [SC-3] Gateway Unresponsive |
| Docker container `exited` or `restarting` | [SC-4] Docker Container Issues |
| Disk > 90% full | [SC-5] Disk Space |
| Memory > 90% used | [SC-6] Memory Pressure |
| Channels not responding / bot silent | [SC-7] Channel Issues |
| Permission denied errors | [SC-8] Permission Problems |
| Service running but bot behaves wrong | [SC-9] Config / Logic Issues |

---

## [SC-1] Service Won't Start (Native)

Check logs: `ssh openclaw@HOST "journalctl --user -u openclaw-gateway -n 50 --no-pager"`

| Finding | Fix |
|---------|-----|
| `openclaw: NOT FOUND` | Reinstall: `curl -fsSL https://openclaw.ai/install.sh \| bash -s -- --no-onboard` |
| Config missing | Rerun openclaw-vps-install skill or write config manually |
| Service file missing | `openclaw gateway install && systemctl --user daemon-reload` |
| `EACCES` | Fix permissions (see [SC-8]) |
| `EADDRINUSE` | `fuser -k 18789/tcp` then restart gateway |
| `Cannot find module` | `npm cache clean --force && npm i -g openclaw@latest` |
| JSON parse error | `python3 -m json.tool ~/.openclaw/openclaw.json` to find syntax issue |

After fix: `systemctl --user restart openclaw-gateway`

---

## [SC-2] Gateway Not Listening

Service active but `ss -tlnp | grep 18789` shows nothing.

- Check process: `ps aux | grep openclaw`
- Check logs for crash after start
- Verify `gateway.bind` in config (must be `loopback` or `127.0.0.1`)
- If port conflict: `fuser -k 18789/tcp` then restart

---

## [SC-3] Gateway Unresponsive

Port open but health fails.

```bash
ssh openclaw@HOST "curl -v http://127.0.0.1:18789/health 2>&1 | tail -10"
```

- `401 Unauthorized` → token mismatch; verify GATEWAY_TOKEN
- Timeout → process hung; `systemctl --user restart openclaw-gateway`
- `500` → check logs for stack trace

---

## [SC-4] Docker Container Issues

```bash
ssh openclaw@HOST "docker compose -f ~/openclaw/docker-compose.yml ps && docker compose -f ~/openclaw/docker-compose.yml logs --tail=50"
```

| Container State | Diagnosis | Fix |
|----------------|-----------|-----|
| `exited (1)` | App crash | Check logs; fix config; restart |
| `restarting` | Crash loop | Stop container, read logs, fix root cause |
| `exited (137)` | OOM killed | Add swap: `fallocate -l 2G /swapfile && mkswap /swapfile && swapon /swapfile` |
| `exited (143)` | Normal stop | Just restart |

Volume permission fix: `chown -R 1000:1000 /home/openclaw/.openclaw`

---

## [SC-5] Disk Space

```bash
ssh openclaw@HOST "df -h / && du -sh /var/log/* 2>/dev/null | sort -hr | head -5"
```

Cleanup (safe order): `apt-get clean` → `journalctl --vacuum-time=7d` → prune old sessions → `docker system prune -f`

---

## [SC-6] Memory Pressure

```bash
ssh openclaw@HOST "free -h && ps aux --sort=-%mem | head -10"
```

- OpenClaw >500MB → restart gateway to reclaim
- System <200MB free → add swap (see SC-4 OOM fix)

---

## [SC-7] Channel Issues

Check channel config and recent errors:

```bash
ssh openclaw@HOST '
  export PATH=$(npm prefix -g)/bin:$PATH
  openclaw status --all 2>/dev/null | grep -A 20 channels
  journalctl --user -u openclaw-gateway -n 100 --no-pager 2>/dev/null | grep -i "telegram\|discord\|channel" | tail -10
'
```

- Token invalid → `openclaw config set channels.telegram.botToken 'NEW_TOKEN'`
- DM policy disabled → `openclaw config set channels.telegram.dmPolicy pairing`
- Pairing pending → `openclaw pairing list telegram` / `openclaw pairing approve telegram CODE`

---

## [SC-8] Permission Problems

```bash
ssh openclaw@HOST "ls -la ~/.openclaw/ && stat -c '%U:%G %a %n' ~/.openclaw ~/.openclaw/openclaw.json"
```

Fix: `chmod 700 ~/.openclaw && chmod 600 ~/.openclaw/openclaw.json && chown -R openclaw:openclaw ~/.openclaw`

---

## [SC-9] Config / Logic Issues

```bash
ssh openclaw@HOST 'export PATH=$(npm prefix -g)/bin:$PATH && openclaw doctor'
```

Common config fixes:

```bash
openclaw config set gateway.bind loopback
openclaw config set discovery.mdns.mode off
openclaw config set session.dmScope per-channel-peer
openclaw gateway restart
```

---

## Escalation

Collect a full diagnostic bundle for support:

```bash
bash scripts/vps-diagnostics.sh openclaw@HOST
```

Sensitive values are automatically redacted. Submit output to:
- Discord: `https://discord.gg/clawd`
- Security issues: `security@openclaw.ai`

---

## Post-Fix Verification

```bash
ssh openclaw@HOST '
  echo -n "Service: "; systemctl --user is-active openclaw-gateway 2>/dev/null || docker inspect openclaw-gateway --format "{{.State.Status}}" 2>/dev/null || echo UNKNOWN
  echo -n "Health: "; curl -sf -H "Authorization: Bearer TOKEN" http://127.0.0.1:18789/health >/dev/null && echo OK || echo FAIL
  echo -n "Port: "; ss -tlnp | grep 18789 | grep -q "127.0.0.1" && echo LOOPBACK || echo CHECK
  echo -n "Config: "; python3 -m json.tool ~/.openclaw/openclaw.json >/dev/null && echo VALID || echo INVALID
'
```
