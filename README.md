# 🦞 Clawdfather

**AI-powered server administration over SSH** — an [OpenClaw](https://openclaw.ai) plugin.

Clawdfather lets you connect to any server via SSH and get an AI assistant that can execute commands, analyze logs, manage services, and provision infrastructure — all through a clean web chat interface.

## How It Works

```
┌──────────┐    ssh -A     ┌───────────────┐     ControlMaster     ┌──────────────┐
│  You      │──────────────▶│  Clawdfather    │─────────────────────▶│ Target Server│
│  (local)  │              │  SSH Server    │                      │  (remote)    │
└──────────┘              └───────┬───────┘                      └──────────────┘
                                  │                                       ▲
                                  │ session URL                           │
                                  ▼                                       │
                          ┌───────────────┐    channel system             │
                          │  Web Chat UI  │──▶ Plugin WS :3000 ──────────┘
                          │  (browser)    │    (inbound → OpenClaw agent)
                          └───────────────┘
```

> **Note:** The web UI connects directly to the plugin's own HTTP/WebSocket server on port 3000 (configurable). The OpenClaw Gateway is fully internal and never exposed to the public internet.

1. **SSH in** — `ssh -A clawdfather.ai` (with agent forwarding)
2. **Pick your target** — Enter `user@host` at the prompt
3. **Agent auth** — Your SSH agent signs the handshake to the target (no passwords stored)
4. **Get a URL** — A web chat URL is returned with your session ID
5. **AI Admin** — Chat with the AI to manage your server. It executes commands through the established SSH tunnel.

## Prerequisites

- **OpenClaw** (installed and running)
- **Node.js** ≥ 18
- **SSH** client on the host machine
- An SSH key loaded in your local agent (`ssh-add`)

## Host Preparation

Before installing Clawdfather, you need to free up **port 22** on the host. Clawdfather listens on port 22 so users can simply `ssh -A clawdfather.ai` — no `-p` flag needed. The host's standard sshd moves to port 2222 for admin access.

> ⚠️ **WARNING:** Follow these steps carefully. If you change sshd's port and can't connect on the new port, you will be locked out of your server. **Always test the new port before closing your current session.**

**Step 1.** Edit `/etc/ssh/sshd_config`:

```
Port 2222
```

**Step 2.** If using SELinux, allow the new port:

```bash
semanage port -a -t ssh_port_t -p tcp 2222
```

**Step 3.** Update firewall to allow the new port:

```bash
# UFW
ufw allow 2222/tcp
ufw reload

# Or firewalld
firewall-cmd --permanent --add-port=2222/tcp
firewall-cmd --reload
```

**Step 4.** Restart sshd:

```bash
systemctl restart sshd
```

**Step 5. 🚨 CRITICAL: Test the new sshd port BEFORE closing your current session:**

```bash
ssh -p 2222 user@clawdfather.ai
```

Open a **new terminal** and verify you can connect. Do NOT close your existing session until this works.

**Step 6.** Once confirmed, port 22 is free for Clawdfather. Continue with installation below.

## Installation

### From source (development)

```bash
# Clone or copy to your workspace
cd ~/.openclaw/workspace
git clone <repo-url> clawdfather
cd clawdfather
npm install

# Install the plugin
openclaw plugins install -l ./
```

### From npm (when published)

```bash
openclaw plugins install @openclaw/clawdfather
```

### Configure

Add to your OpenClaw config (`openclaw.json`):

```json5
{
  plugins: {
    entries: {
      clawdfather: {
        enabled: true,
        config: {
          sshPort: 22,           // Port for the SSH server (default 22)
          webDomain: "clawdfather.ai", // Domain for the web UI URL
          sessionTimeoutMs: 1800000, // 30 min default
          // hostKeyPath: "..."     // Optional custom host key
        }
      }
    }
  },
  // No custom tools needed — Clawdfather uses native OpenClaw exec tool
  // Just ensure the exec tool is available to the agent (it is by default)
}
```

Restart the gateway:

```bash
openclaw gateway restart
```

## Usage

### 1. Connect via SSH

```bash
ssh -A clawdfather.ai
```

> **Note:** `-A` enables agent forwarding. Your local SSH keys are used to authenticate to the target server — nothing is stored by Clawdfather.

### 2. Enter destination

```
╔═══════════════════════════════════════════════════════════════╗
║       🦞  C L A W F A T H E R                                ║
║       AI-Powered Server Administration                        ║
╚═══════════════════════════════════════════════════════════════╝

  Enter destination (user@host[:port]): root@10.0.0.5
```

### 3. Get your URL

```
  ✅ Connected!

  ┌─────────────────────────────────────────────────────┐
  │  🌐 Open your admin console:                       │
  │                                                     │
  │  https://clawdfather.ai/#session=a1b2c3d4-...       │
  │                                                     │
  │  Session: a1b2c3d4...                               │
  │  Target:  root@10.0.0.5                             │
  └─────────────────────────────────────────────────────┘
```

### 4. Open the web UI and chat

The AI will automatically run initial recon on your server and be ready to help with:

- **Package management** — Install, update, remove packages
- **Service management** — Start, stop, restart, check logs
- **Security auditing** — Open ports, failed logins, firewall rules
- **Log analysis** — Search and analyze system/application logs
- **Performance** — CPU, memory, disk, network diagnostics
- **Docker** — Container management, logs, stats
- **Configuration** — Edit configs, test syntax, reload services
- **Provisioning** — Set up new services, users, firewall rules

## Web UI

The web UI is served by the plugin's own HTTP server on port 3000 (configurable via `webPort`). It features:

- Dark terminal-aesthetic theme
- Real-time streaming responses
- Code block syntax highlighting with copy buttons
- Markdown rendering
- Auto-reconnect on disconnect
- Mobile responsive

## Architecture

### Plugin Components

| Component | File | Purpose |
|-----------|------|---------|
| Plugin entry | `src/index.ts` | Registers channel + SSH service with OpenClaw |
| Channel | `src/channel.ts` | OpenClaw channel plugin definition |
| Inbound | `src/inbound.ts` | Routes web UI messages through OpenClaw agent |
| Web server | `src/web-server.ts` | HTTP + WebSocket server on port 3000 |
| SSH server | `src/ssh-server.ts` | Custom SSH2 server with agent forwarding |
| Session store | `src/sessions.ts` | In-memory session management |
| Web UI | `ui/` | Static HTML/CSS/JS chat interface |
| Admin skill | `skills/clawdfather/` | AI instructions for server admin |

### Agent Tools

Clawdfather does **not** register custom agent tools. Instead, the web UI injects an SSH ControlMaster prefix into the session context, and the agent uses OpenClaw's native `exec` tool to run `ssh` and `scp` commands through the established tunnel. This gives the agent full access to PTY mode, background processes, streaming output, and timeouts — all native OpenClaw capabilities.

### Gateway RPC

| Method | Description |
|--------|-------------|
| `clawdfather.sessions` | List all active sessions |
| `clawdfather.session` | Get info about a specific session |

### Security Model

Clawdfather is a **portal app**, not a server login. It uses SSH public key authentication to identify users — the same approach as [terminal.shop](https://terminal.shop).

**How it works:**
1. You run `ssh -A clawdfather.ai` — your SSH client offers your public key
2. Clawdfather accepts any valid public key (no account creation needed)
3. Your key's SHA256 fingerprint becomes your identity (for audit trails, future billing, allowlists)
4. You pick a target server — Clawdfather uses your forwarded SSH agent (`-A`) to authenticate there
5. The agent protocol never exposes your private key — it only asks your local agent to sign challenges

**This is NOT the same as logging into the host.** Clawdfather runs on port 22 as an app. Host admin SSH (standard sshd) runs on port 2222 with its own authentication. These are completely separate.

**Security features:**

- **Public key only** — Password and other auth methods are rejected. No credentials to phish or leak.
- **Fingerprint-based identity** — Each user is identified by their key's SHA256 fingerprint for audit trails and future allowlists/billing.
- **Session isolation** — Each session has a unique UUID and its own ControlMaster socket.
- **ControlMaster lifecycle management** — When sessions expire or are removed, the ControlMaster is cleanly terminated (`ssh -O exit`) and the socket file is removed.
- **Tool safety** — AI follows strict rules about destructive commands (see SKILL.md).

## Production Deployment

### 1. DNS

Create an **A record** pointing `clawdfather.ai` (or your domain) to your server's public IP.

### 2. SSH Port

Clawdfather listens on **port 22** by default (configured in [Host Preparation](#host-preparation) above). Ensure sshd has been moved to port 2222 before starting the gateway.

**Step 7.** Update firewall for the full setup:

```bash
ufw allow 22/tcp    # Clawdfather SSH (public-facing)
ufw allow 2222/tcp  # Host admin SSH
ufw allow 443/tcp   # Web UI (HTTPS)
ufw allow 80/tcp    # ACME challenges / redirect
ufw reload
```

### 3. Firewall

Open these ports:

| Port | Protocol | Purpose |
|------|----------|---------|
| 22/tcp | SSH | Clawdfather SSH server (public-facing) |
| 2222/tcp | SSH | Host sshd (your admin access) |
| 3000/tcp | HTTP/WS | Plugin web server (only if not behind Caddy) |
| 443/tcp | HTTPS | Web UI (via Caddy) |
| 80/tcp | HTTP | ACME challenges / redirect |

> If using Caddy as a reverse proxy, port 3000 does **not** need to be opened publicly — Caddy connects to it locally.

### 4. TLS with Caddy

Caddy handles TLS automatically via Let's Encrypt — see the Caddy example below.

### 5. Gateway

The OpenClaw Gateway is **fully internal** — it is not exposed to the public internet. The web UI connects to the plugin's own HTTP/WebSocket server on port 3000, which routes messages through the OpenClaw channel system internally.

## DNS/Networking Setup

For `clawdfather.ai` to work, you need:

1. **DNS A record** pointing `clawdfather.ai` to your OpenClaw host
2. **Port forwarding** for SSH port (default 22) and web port (default 3000)
3. **TLS** for the web UI (Caddy recommended — auto-provisions Let's Encrypt certs)

> The OpenClaw Gateway is internal only — it should **not** be exposed to the public internet. Caddy proxies to the plugin's web server on port 3000, not the Gateway.

> **Note:** SSH traffic (port 22) goes directly to the Clawdfather SSH server, not through Caddy. Only HTTP/HTTPS/WebSocket traffic is reverse-proxied.

### Example with Caddy (recommended)

Caddy handles TLS automatically via Let's Encrypt — no cert configuration needed.

```caddyfile
clawdfather.ai {
    # Proxy to the plugin's own web/WebSocket server
    # Caddy automatically handles WebSocket upgrade headers
    reverse_proxy * localhost:3000
}
```

Install and run:

```bash
# Install Caddy (https://caddyserver.com/docs/install)
sudo apt install -y caddy    # Debian/Ubuntu
# or: brew install caddy      # macOS

# Start with your Caddyfile
sudo caddy start --config /etc/caddy/Caddyfile
```

That's it. Caddy will:
- Obtain and renew TLS certificates automatically
- Proxy HTTP and WebSocket traffic to the plugin's web server (port 3000)
- The OpenClaw Gateway stays internal — never exposed publicly

### Example with Tailscale

```bash
# Expose via Tailscale Serve
openclaw gateway --tailscale serve

# SSH is available on your Tailscale IP
ssh -A your-machine.tail1234.ts.net
```

## Development

```bash
cd clawdfather
npm install
npm run keygen  # Generate SSH host key (first time)

# Link as local plugin
openclaw plugins install -l ./

# Restart gateway to load
openclaw gateway restart
```

## Troubleshooting

**"Failed to connect to target"**
- Verify your SSH agent has keys loaded: `ssh-add -l`
- Test direct SSH first: `ssh user@host`
- Check the target accepts your key

**Web UI shows "disconnected"**
- Ensure the OpenClaw gateway is running
- Check the gateway URL and auth token
- Look at browser console for WebSocket errors

**Session expired**
- Sessions timeout after 30 min of inactivity (configurable)
- Re-run `ssh -A clawdfather.ai` to create a new session

## License

MIT
