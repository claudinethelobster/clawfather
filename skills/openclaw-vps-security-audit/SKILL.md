---
name: openclaw-vps-security-audit
version: 2.0.0
description: Clawdfather-native VPS security audit playbook for OpenClaw. Executes directly via SSH — checks firewall, systemd hardening, file permissions, SSH config, Docker security, and generates a compliance report. Covers native and Docker variants.
author: clawdfather
---

# OpenClaw VPS Security Audit — Clawdfather Playbook

Read-only audit first, then targeted hardening. Collect all findings before applying any fixes.

## Security Defaults

Every OpenClaw VPS must meet these baselines:

- **Loopback bind** — gateway listens on 127.0.0.1 only
- **Token auth** — 32+ char hex token required
- **mDNS off** — no network discovery
- **Elevated tools disabled** — `tools.elevated.enabled = false`
- **DM scope** — `per-channel-peer`
- **UFW + fail2ban** — deny all incoming except SSH

---

## Audit Overview

| Section | Checks | Applies To |
|---------|--------|------------|
| [A1] Firewall | UFW rules, default policy, exposed ports | Both |
| [A2] OpenClaw Config | Bind, auth, mDNS, dmScope, tools | Both |
| [A3] File Permissions | .openclaw dir, config, credentials | Both |
| [A4] SSH Hardening | Root login, password auth, key-only | Both |
| [A5] Systemd Hardening | Service security flags, user isolation | Native |
| [A6] Docker Security | Image user, network, volumes | Docker |
| [A7] System Hygiene | Updates, fail2ban, unused services | Both |

---

## Run Audit

```bash
bash scripts/vps-security-audit.sh root@HOST openclaw@HOST
```

Prints PASS/CRITICAL/HIGH/MEDIUM for each check with a summary at the end.

---

## Evaluate Findings

### [A1] Firewall

| Check | Expected | Severity if Wrong |
|-------|----------|-------------------|
| UFW active | `Status: active` | CRITICAL |
| Default incoming | `DENY` | CRITICAL |
| Only SSH open externally | Port 22 only | CRITICAL |
| Port 18789 not on 0.0.0.0 | Loopback only | CRITICAL |

### [A2] OpenClaw Config

| Check | Expected | Severity if Wrong |
|-------|----------|-------------------|
| `gateway.bind` | `loopback` | CRITICAL |
| `gateway.auth.mode` | `token` | CRITICAL |
| `gateway.auth.token` | SET, length >= 32 | CRITICAL |
| `discovery.mdns.mode` | `off` | MEDIUM |
| `session.dmScope` | `per-channel-peer` | MEDIUM |
| `tools.elevated.enabled` | `false` | HIGH |
| `tools.exec.security` | `ask` or `deny` | HIGH |

### [A3] File Permissions

| Check | Expected | Severity if Wrong |
|-------|----------|-------------------|
| `.openclaw` dir mode | `700` | HIGH |
| `openclaw.json` mode | `600` | CRITICAL |
| `credentials/` files | `600` | CRITICAL |

### [A4] SSH Config

| Check | Expected | Severity if Wrong |
|-------|----------|-------------------|
| `PermitRootLogin` | `no` | HIGH |
| `PasswordAuthentication` | `no` | HIGH |
| `MaxAuthTries` | `3` or less | MEDIUM |

### [A5] Systemd Hardening (Native)

| Check | Expected | Severity if Wrong |
|-------|----------|-------------------|
| `NoNewPrivileges=yes` | Present | MEDIUM |
| `PrivateTmp=yes` | Present | MEDIUM |
| `ProtectSystem` | `full` or `strict` | MEDIUM |

### [A6] Docker Security

| Check | Expected | Severity if Wrong |
|-------|----------|-------------------|
| Container user | Non-root | HIGH |
| `Privileged` | `false` | CRITICAL |
| Port binding | `127.0.0.1:18789` | CRITICAL |

---

## Apply Hardening

```bash
bash scripts/vps-hardening.sh root@HOST openclaw@HOST
```

Applies: UFW, fail2ban, file permissions, loopback bind, mDNS off, dmScope, elevated tools, SSH hardening (with prominent warning), systemd hardening directives.

**WARNING:** The SSH hardening step disables root login and password auth. Verify key-based access works first.

---

## Inline Quick Fixes

For individual findings, apply directly:

```bash
# Rebind gateway to loopback
openclaw config set gateway.bind loopback

# Disable mDNS
openclaw config set discovery.mdns.mode off

# Set DM scope
openclaw config set session.dmScope per-channel-peer

# Disable elevated tools
openclaw config set tools.elevated.enabled false

# Set exec security
openclaw config set tools.exec.security ask

# Restart to apply
openclaw gateway restart
```

Fix file permissions:

```bash
chmod 700 ~/.openclaw && chmod 600 ~/.openclaw/openclaw.json
chown -R openclaw:openclaw ~/.openclaw
```

---

## Severity Key

| Level | Action Required |
|-------|----------------|
| CRITICAL | Gateway exposed or auth missing — fix immediately |
| HIGH | Privilege escalation or data exposure risk — fix within 24h |
| MEDIUM | Defense-in-depth weakened — fix within 7 days |
| PASS | Compliant — no action needed |

---

## Audit Schedule

| Frequency | Trigger |
|-----------|---------|
| Every install / update | Run full audit after any deployment change |
| Weekly | Schedule via cron or manual check |
| After incident | Full audit + credential rotation |
| Before sharing access | Verify DM policies and allowlists |

---

## Quick Hardening Checklist

```bash
# Run on root@HOST
ufw default deny incoming && ufw allow ssh && echo 'y' | ufw enable
systemctl enable fail2ban && systemctl start fail2ban
chmod 700 /home/openclaw/.openclaw
chmod 600 /home/openclaw/.openclaw/openclaw.json
chown -R openclaw:openclaw /home/openclaw/.openclaw

# Run on openclaw@HOST
openclaw config set gateway.bind loopback
openclaw config set discovery.mdns.mode off
openclaw config set session.dmScope per-channel-peer
openclaw config set tools.elevated.enabled false
openclaw gateway restart
```
