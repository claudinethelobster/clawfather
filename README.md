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
                          ┌───────────────┐    native exec (ssh/scp)      │
                          │  Web Chat UI  │──▶ OpenClaw Gateway ──────────┘
                          │  (browser)    │    (AI + exec tool)
                          └───────────────┘
```

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
          sshPort: 2222,         // Port for the SSH server (default 2222)
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

The web UI is served by the OpenClaw Gateway at `/clawdfather/`. It features:

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
| Plugin entry | `src/index.ts` | SSH server, HTTP server, session management |
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

### Security Model — Two-Tier SSH Authentication

Clawdfather uses a **two-tier authentication model**:

**Regular users** (`ssh clawdfather.ai` or `ssh user@clawdfather.ai`):
- **Public key only** — Any valid public key is accepted (like [terminal.shop](https://terminal.shop)). No account creation needed. Your private key never leaves your machine.

**Root user** (`ssh root@clawdfather.ai`):
- **Public key + password (2FA)** — The key fingerprint must be in the configured allowlist AND a password must be provided as a second factor.
- Configure via `rootAllowedFingerprints` (array of `SHA256:...` strings) and `rootPassword` in the plugin config.
- If no allowlist is configured, any valid key is accepted for the first factor.
- If no root password is configured, the password requirement is waived.

**Authentication flow (Clawdfather → Target):**
- Your SSH agent forwarding (`-A`) allows Clawdfather to authenticate to the target server on your behalf. The agent protocol never exposes your private key — it only asks your local agent to sign challenges.

**Security features:**

- **Brute-force protection** — Max 5 failed auth attempts per connection, then disconnect.
- **Constant-time password comparison** — Prevents timing attacks on the root password.
- **Fingerprint-based identity** — Each user is identified by their key's SHA256 fingerprint for audit trails.
- **Session isolation** — Each session has a unique UUID and its own ControlMaster socket.
- **ControlMaster lifecycle management** — When sessions expire or are removed, the ControlMaster is cleanly terminated (`ssh -O exit`) and the socket file is removed.
- **Gateway auth** — The web UI still requires your OpenClaw gateway token/password.
- **Tool safety** — AI follows strict rules about destructive commands (see SKILL.md).

## Production Deployment

### 1. DNS

Create an **A record** pointing `clawdfather.ai` (or your domain) to your server's public IP.

### 2. SSH Port

The default SSH port is **2222** to avoid conflicting with the host's own sshd on port 22. Users connect with:

```bash
ssh -A -p 2222 clawdfather.ai
```

If you want `ssh clawdfather.ai` to work without `-p`, set `sshPort: 22` in config — but make sure your host sshd is moved to another port first.

### 3. Firewall

Open these ports:

| Port | Protocol | Purpose |
|------|----------|---------|
| 22/tcp | SSH | Host sshd (your own access) |
| 2222/tcp | SSH | Clawdfather SSH server |
| 443/tcp | HTTPS | Web UI (via Caddy) |
| 80/tcp | HTTP | ACME challenges / redirect |

### 4. TLS with Caddy

Caddy handles TLS automatically via Let's Encrypt — see the Caddy example below.

### 5. Gateway Auth

The web UI requires your OpenClaw gateway token/password. Ensure the gateway is configured with authentication before exposing publicly.

## DNS/Networking Setup

For `clawdfather.ai` to work, you need:

1. **DNS A record** pointing `clawdfather.ai` to your OpenClaw host
2. **Port forwarding** for SSH port (default 2222) and Gateway port (18789)
3. **TLS** for the web UI (Caddy recommended — auto-provisions Let's Encrypt certs)

> **Note:** SSH traffic (port 2222) goes directly to the Clawdfather SSH server, not through Caddy. Only HTTP/HTTPS/WebSocket traffic is reverse-proxied.

### Example with Caddy (recommended)

Caddy handles TLS automatically via Let's Encrypt — no cert configuration needed.

```caddyfile
clawdfather.ai {
    # Visiting the root redirects to the web UI
    redir / /clawdfather/ permanent

    # Proxy everything to the OpenClaw Gateway
    # Caddy automatically handles WebSocket upgrade headers
    reverse_proxy * localhost:18789
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
- Proxy HTTP requests to the OpenClaw Gateway (port 18789)
- Handle WebSocket connections transparently (needed for Gateway WS)
- Redirect `https://clawdfather.ai/` → `https://clawdfather.ai/clawdfather/`

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
