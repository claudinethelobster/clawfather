---
name: openclaw-vps-session
version: 1.0.0
description: Manages a persistent SSH session to the VPS. Load this skill first. All other VPS skills assume this session is active.
author: clawdfather
---

# OpenClaw VPS Session — Persistent SSH Connection

Entry-point skill for all VPS operations. Load this **before** any other VPS skill (`openclaw-vps-install`, `openclaw-vps-security-audit`, `openclaw-vps-troubleshoot`). Establishes and manages a persistent SSH session via ControlMaster so subsequent commands reuse a single connection.

---

## Session Start

Establish a persistent SSH session with ControlMaster:

```bash
ssh -M -S /tmp/clawdfather-vps-%r@%h \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes \
    -o StrictHostKeyChecking=no \
    -fN openclaw@VPS_HOST
```

This backgrounds the master connection. All subsequent commands reuse it via the socket.

---

## Keepalive

- **ServerAliveInterval=30** — client sends a keepalive every 30 seconds
- **ServerAliveCountMax=3** — drops the connection after 3 missed keepalives (90s window)

The master stays alive as long as commands flow through it or the 90-second keepalive window hasn't expired. For long-running VPS work, the steady command traffic keeps it open indefinitely.

---

## Session Verification

Confirm the session is active:

```bash
ssh -S /tmp/clawdfather-vps-openclaw@VPS_HOST -O check openclaw@VPS_HOST
```

- Output contains `Master running` → session active, proceed normally
- Any other output or error → session dropped, reconnect needed

---

## Reconnect Strategy

If the session drops (network blip, server restart):

```bash
# Kill stale socket if present
ssh -S /tmp/clawdfather-vps-openclaw@VPS_HOST -O exit openclaw@VPS_HOST 2>/dev/null || true
rm -f /tmp/clawdfather-vps-openclaw@VPS_HOST

# Re-establish
ssh -M -S /tmp/clawdfather-vps-%r@%h \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -fN openclaw@VPS_HOST
```

---

## tmux Strategy for Long-Lived Work

For long-running operations on the VPS, always use a named tmux session so work survives reconnects:

```bash
# On VPS: start or attach a named tmux session
tmux new-session -A -s openclaw-ops
```

Run long operations inside tmux. If the SSH session drops, reconnect and reattach:

```bash
tmux attach -t openclaw-ops
```

---

## Executing Commands in Session

The standard pattern for all other VPS skills:

```bash
ssh -S /tmp/clawdfather-vps-openclaw@VPS_HOST openclaw@VPS_HOST 'COMMAND_HERE'
```

For interactive/TTY commands, add the `-t` flag:

```bash
ssh -t -S /tmp/clawdfather-vps-openclaw@VPS_HOST openclaw@VPS_HOST 'COMMAND_HERE'
```

For file transfer, use the ControlPath:

```bash
# scp
scp -o ControlPath=/tmp/clawdfather-vps-openclaw@VPS_HOST localfile openclaw@VPS_HOST:/remote/path

# rsync
rsync -e 'ssh -S /tmp/clawdfather-vps-openclaw@VPS_HOST' localdir/ openclaw@VPS_HOST:/remote/dir/
```

---

## Clean Shutdown

Terminate the session cleanly when done:

```bash
ssh -S /tmp/clawdfather-vps-openclaw@VPS_HOST -O exit openclaw@VPS_HOST
rm -f /tmp/clawdfather-vps-openclaw@VPS_HOST
```

---

## Session Reset

Full reset when things are broken:

```bash
pkill -f "ssh.*clawdfather-vps" || true
rm -f /tmp/clawdfather-vps-*

# Wait for processes to die, then re-establish
sleep 5
ssh -M -S /tmp/clawdfather-vps-%r@%h \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -fN openclaw@VPS_HOST
```

---

## Session Status Table

| Indicator | Meaning | Action |
|-----------|---------|--------|
| `ssh -O check` → "Master running" | Session active | None |
| `ssh -O check` → error/timeout | Session dropped | Reconnect |
| Socket file missing | Never connected or reset | Establish |
| Commands hang | Network issue or VPS overloaded | Reset |

---

## Security Notes

- ControlMaster sockets are created in `/tmp` with restrictive permissions (owner-only)
- Never share socket paths or expose them to other users
- Session uses existing SSH key auth — no passwords
- The socket file name includes the username and host for uniqueness

---

## SSH Config Shortcut (Optional)

Add to `~/.ssh/config` for automatic ControlMaster on all VPS connections:

```
Host vps-openclaw
  HostName VPS_HOST
  User openclaw
  ControlMaster auto
  ControlPath /tmp/clawdfather-vps-%r@%h
  ControlPersist 10m
  ServerAliveInterval 30
  ServerAliveCountMax 3
```

With this config, `ssh vps-openclaw` handles session management automatically and `ControlPersist 10m` keeps the master alive for 10 minutes after the last session closes.
