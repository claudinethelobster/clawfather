# 🦞 Clawfather

**AI-powered server administration over SSH** — an [OpenClaw](https://openclaw.ai) plugin.

Clawfather lets you connect to any server via SSH and get an AI assistant that can execute commands, analyze logs, manage services, and provision infrastructure — all through a clean web chat interface.

## How It Works

```
┌──────────┐    ssh -A     ┌───────────────┐     ControlMaster     ┌──────────────┐
│  You      │──────────────▶│  Clawfather    │─────────────────────▶│ Target Server│
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

1. **SSH in** — `ssh -A clawfather.ai` (with agent forwarding)
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
git clone <repo-url> clawfather
cd clawfather
npm install

# Install the plugin
openclaw plugins install -l ./
```

### From npm (when published)

```bash
openclaw plugins install @openclaw/clawfather
```

### Configure

Add to your OpenClaw config (`openclaw.json`):

```json5
{
  plugins: {
    entries: {
      clawfather: {
        enabled: true,
        config: {
          sshPort: 2222,           // Port for the SSH server
          webDomain: "clawfather.ai", // Domain for the web UI URL
          webProto: "https",       // http or https
          sessionTimeoutMs: 1800000, // 30 min default
          // hostKeyPath: "..."     // Optional custom host key
          // controlPathDir: "/tmp" // Where ControlMaster sockets live
        }
      }
    }
  },
  // No custom tools needed — Clawfather uses native OpenClaw exec tool
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
ssh -A -p 2222 clawfather.ai
```

> **Note:** `-A` enables agent forwarding. Your local SSH keys are used to authenticate to the target server — nothing is stored by Clawfather.

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
  │  https://clawfather.ai/#session=a1b2c3d4-...       │
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

The web UI is served by the OpenClaw Gateway at `/clawfather/`. It features:

- Dark terminal-aesthetic theme
- Real-time streaming responses
- Code block syntax highlighting with copy buttons
- Markdown rendering
- Auto-reconnect on disconnect
- Mobile responsive

### Auth

The web UI authenticates to the OpenClaw Gateway using the same token/password as the Control UI. Pass it via URL parameter on first load:

```
https://clawfather.ai/clawfather/?token=YOUR_TOKEN#session=SESSION_ID
```

The token is stored in localStorage for subsequent visits.

## Architecture

### Plugin Components

| Component | File | Purpose |
|-----------|------|---------|
| Plugin entry | `src/index.ts` | SSH server, HTTP server, session management |
| SSH server | `src/ssh-server.ts` | Custom SSH2 server with agent forwarding |
| Session store | `src/sessions.ts` | In-memory session management |
| Web UI | `ui/` | Static HTML/CSS/JS chat interface |
| Admin skill | `skills/clawfather/` | AI instructions for server admin |

### Agent Tools

Clawfather does **not** register custom agent tools. Instead, the web UI injects an SSH ControlMaster prefix into the session context, and the agent uses OpenClaw's native `exec` tool to run `ssh` and `scp` commands through the established tunnel. This gives the agent full access to PTY mode, background processes, streaming output, and timeouts — all native OpenClaw capabilities.

### Gateway RPC

| Method | Description |
|--------|-------------|
| `clawfather.sessions` | List all active sessions |
| `clawfather.session` | Get info about a specific session |

### Security Model

- **No credentials stored** — All auth uses SSH agent forwarding
- **ControlMaster sessions** — Persist for 30 min, auto-cleaned
- **Gateway auth** — Web UI requires OpenClaw gateway token/password
- **Session isolation** — Each session has a unique UUID and ControlMaster socket
- **Tool safety** — AI follows strict rules about destructive commands (see SKILL.md)

## DNS/Networking Setup

For `clawfather.ai` to work, you need:

1. **DNS A record** pointing `clawfather.ai` to your OpenClaw host
2. **Port forwarding** for SSH port (default 2222) and Gateway port (18789)
3. **TLS** for the web UI (use Tailscale Serve, nginx, or Caddy as reverse proxy)

### Example with Tailscale

```bash
# Expose via Tailscale Serve
openclaw gateway --tailscale serve

# SSH is available on your Tailscale IP
ssh -A -p 2222 your-machine.tail1234.ts.net
```

### Example with nginx

```nginx
server {
    server_name clawfather.ai;
    listen 443 ssl;
    # ... SSL config ...

    # Web UI
    location /clawfather/ {
        proxy_pass http://127.0.0.1:18789/clawfather/;
    }

    # Gateway WebSocket
    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

## Development

```bash
cd clawfather
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
- Re-run `ssh -A clawfather.ai` to create a new session

## License

MIT
