import { Server, Connection } from 'ssh2';
import { createHash } from 'crypto';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { join, dirname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { sessionStore } from './sessions';
import { ClawdfatherConfig, Session } from './types';

/** ASCII art banner */
const BANNER = `\r
\x1b[32m   ██████╗██╗      █████╗ ██╗    ██╗███████╗ █████╗ ████████╗██╗  ██╗███████╗██████╗ \x1b[0m\r
\x1b[32m  ██╔════╝██║     ██╔══██╗██║    ██║██╔════╝██╔══██╗╚══██╔══╝██║  ██║██╔════╝██╔══██╗\x1b[0m\r
\x1b[32m  ██║     ██║     ███████║██║ █╗ ██║█████╗  ███████║   ██║   ███████║█████╗  ██████╔╝\x1b[0m\r
\x1b[32m  ██║     ██║     ██╔══██║██║███╗██║██╔══╝  ██╔══██║   ██║   ██╔══██║██╔══╝  ██╔══██╗\x1b[0m\r
\x1b[32m  ╚██████╗███████╗██║  ██║╚███╔███╔╝██║     ██║  ██║   ██║   ██║  ██║███████╗██║  ██║\x1b[0m\r
\x1b[32m   ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚═╝     ╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝\x1b[0m\r
\r
\x1b[33m  Secure AI-Powered Server Administration\x1b[0m\r
\x1b[90m  ─────────────────────────────────────────\x1b[0m\r
`;

/** Ensure SSH host key exists, generate if needed */
function ensureHostKey(keyPath: string): Buffer {
  if (!existsSync(keyPath)) {
    const dir = dirname(keyPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    console.log(`[clawdfather] Generating SSH host key at ${keyPath}`);
    execSync(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);
  }
  return readFileSync(keyPath);
}

/** Parse "user@host:port" → { user, host, port } */
function parseDestination(input: string): { user: string; host: string; port: number } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^([^@]+)@([^:]+)(?::(\d+))?$/);
  if (!match) return null;
  return { user: match[1], host: match[2], port: match[3] ? parseInt(match[3], 10) : 22 };
}

/** Establish ControlMaster SSH connection to target */
function establishControlMaster(
  targetUser: string,
  targetHost: string,
  targetPort: number,
  controlPath: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const args = [
      '-A',
      '-o', 'ControlMaster=yes',
      '-o', `ControlPath=${controlPath}`,
      '-o', 'ControlPersist=600',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=15',
      '-p', String(targetPort),
      '-N',
      `${targetUser}@${targetHost}`,
    ];

    const proc = spawn('ssh', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stderr = '';
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    // Check if socket appears within 10s
    const timer = setTimeout(() => {
      if (existsSync(controlPath)) {
        resolve(true);
      } else {
        proc.kill();
        resolve(false);
      }
    }, 10_000);

    proc.on('close', () => {
      clearTimeout(timer);
      resolve(existsSync(controlPath));
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      console.error(`[clawdfather] SSH spawn error: ${err.message}`);
      resolve(false);
    });
  });
}

/** Handle user destination input */
async function handleInput(
  stream: any,
  input: string,
  client: Connection,
  config: ClawdfatherConfig,
  keyFingerprint: string
): Promise<void> {
  const dest = parseDestination(input);
  if (!dest) {
    stream.write('\x1b[31m  ✗ Invalid format. Use: user@hostname[:port]\x1b[0m\r\n\r\n');
    stream.write('\x1b[32m  ➜ \x1b[0m');
    return;
  }

  stream.write(`\r\n\x1b[90m  Connecting to ${dest.user}@${dest.host}:${dest.port}...\x1b[0m\r\n`);

  const sessionId = uuidv4();
  const controlPath = `/tmp/clawdfather-${sessionId}`;

  const success = await establishControlMaster(dest.user, dest.host, dest.port, controlPath);

  if (!success) {
    stream.write('\x1b[31m  ✗ Failed to connect. Check your credentials and agent forwarding.\x1b[0m\r\n');
    stream.write('\x1b[90m  Make sure you connected with: ssh -A ...\x1b[0m\r\n\r\n');
    stream.write('\x1b[32m  ➜ \x1b[0m');
    return;
  }

  const session: Session = {
    sessionId,
    keyFingerprint,
    targetHost: dest.host,
    targetUser: dest.user,
    targetPort: dest.port,
    controlPath,
    connectedAt: Date.now(),
    lastActivity: Date.now(),
  };
  sessionStore.create(session);

  const protocol = config.webDomain === 'localhost' ? 'http' : 'https';
  const url = `${protocol}://${config.webDomain}/#session=${sessionId}`;

  stream.write('\r\n');
  stream.write('\x1b[32m  ✓ Connected successfully!\x1b[0m\r\n\r\n');
  stream.write('\x1b[90m  ─────────────────────────────────────────\x1b[0m\r\n');
  stream.write('\x1b[33m  Your admin console is ready:\x1b[0m\r\n\r\n');
  stream.write(`\x1b[1;36m  ${url}\x1b[0m\r\n\r\n`);
  stream.write('\x1b[90m  ─────────────────────────────────────────\x1b[0m\r\n');
  stream.write(`\x1b[90m  Session: ${sessionId}\x1b[0m\r\n`);
  stream.write(`\x1b[90m  Target:  ${dest.user}@${dest.host}:${dest.port}\x1b[0m\r\n`);
  stream.write('\x1b[90m  Timeout: 30 minutes of inactivity\x1b[0m\r\n\r\n');
  stream.write('\x1b[33m  You can close this terminal. Session has a 60s grace period.\x1b[0m\r\n');
  stream.write('\x1b[90m  Press Ctrl+C or wait to disconnect.\x1b[0m\r\n');

  const gracePeriodMs = 60_000;

  // When the SSH client disconnects, schedule session removal after a
  // short grace period so the user has time to open the web UI.
  client.once('close', () => {
    setTimeout(() => {
      if (sessionStore.get(sessionId)) {
        sessionStore.remove(sessionId);
        console.log(`[clawdfather] Session ${sessionId} invalidated (SSH disconnected after grace period)`);
      }
    }, gracePeriodMs);
  });

  setTimeout(() => {
    stream.write('\r\n\x1b[90m  Closing SSH session. Web console remains active for 60s grace period.\x1b[0m\r\n');
    stream.write('\x1b[33m  Goodbye! 🐾\x1b[0m\r\n');
    try { stream.close(); } catch (_e: unknown) { /* ignore */ }
    client.end();
  }, 30_000);
}

/** Start the Clawdfather SSH server */
export function startSSHServer(config: ClawdfatherConfig): Server {
  const keyPath = config.hostKeyPath || join(__dirname, '..', 'keys', 'host_ed25519');
  const hostKey = ensureHostKey(keyPath);

  const server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
    console.log('[clawdfather] Client connected');

    let keyFingerprint = '';

    client.on('authentication', (ctx) => {
      if (ctx.method === 'publickey') {
        // Accept any valid public key — identity tracked by fingerprint
        const fingerprint = createHash('sha256').update(ctx.key.data).digest('base64');
        keyFingerprint = `SHA256:${fingerprint}`;
        console.log(`[clawdfather] Public key auth from ${ctx.username}: ${keyFingerprint}`);
        ctx.accept();
      } else if (ctx.method === 'none') {
        // Initial probe — tell client we only accept publickey
        ctx.reject(['publickey']);
      } else {
        // Reject password and all other methods — publickey only
        ctx.reject(['publickey']);
      }
    });

    client.on('ready', () => {
      console.log('[clawdfather] Client authenticated');

      client.on('session', (accept) => {
        const session = accept();

        session.on('pty', (accept) => { accept(); });

        session.on('shell', (accept) => {
          const stream = accept();
          stream.write(BANNER);
          stream.write('\r\n');
          stream.write('\x1b[36m  Where would you like to connect?\x1b[0m\r\n');
          stream.write('\x1b[90m  Format: user@hostname[:port]\x1b[0m\r\n\r\n');
          stream.write('\x1b[32m  ➜ \x1b[0m');

          let inputBuffer = '';

          stream.on('data', (data: Buffer) => {
            const str = data.toString();
            for (const char of str) {
              if (char === '\r' || char === '\n') {
                stream.write('\r\n');
                handleInput(stream, inputBuffer, client, config, keyFingerprint);
                inputBuffer = '';
                return;
              } else if (char === '\x7f' || char === '\b') {
                if (inputBuffer.length > 0) {
                  inputBuffer = inputBuffer.slice(0, -1);
                  stream.write('\b \b');
                }
              } else if (char === '\x03') {
                stream.write('\r\n\x1b[33m  Goodbye!\x1b[0m\r\n');
                stream.close();
                return;
              } else if (char.charCodeAt(0) >= 32) {
                inputBuffer += char;
                stream.write(char);
              }
            }
          });
        });
      });
    });

    client.on('error', (err: Error) => {
      console.error(`[clawdfather] Client error: ${err.message}`);
    });

    client.on('close', () => {
      console.log('[clawdfather] Client disconnected');
    });
  });

  server.listen(config.sshPort, '0.0.0.0', () => {
    console.log(`[clawdfather] SSH server listening on port ${config.sshPort}`);
  });

  server.on('error', (err: Error) => {
    console.error(`[clawdfather] Server error: ${err.message}`);
  });

  return server;
}
