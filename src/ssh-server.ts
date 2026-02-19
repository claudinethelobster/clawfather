import { Server, Connection } from 'ssh2';
import { createHash } from 'crypto';
import { readFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { createServer as createNetServer, Server as NetServer } from 'net';
import { join, dirname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { sessionStore } from './sessions';
import { closeSessionClients } from './web-server';
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

/**
 * Open an auth-agent@openssh.com channel back to the SSH client.
 * Uses ssh2 internals since the server Connection class doesn't expose this publicly.
 */
function openAgentChannel(client: Connection): Promise<NodeJS.ReadWriteStream> {
  return new Promise((resolve, reject) => {
    const proto = (client as any)._protocol;
    const chanMgr = (client as any)._chanMgr;
    if (!proto || !chanMgr) {
      reject(new Error('Cannot access ssh2 internals for agent forwarding'));
      return;
    }

    const wrapper: any = (err: Error | undefined, stream: any) => {
      if (err) reject(err);
      else resolve(stream);
    };
    wrapper.type = 'auth-agent@openssh.com';

    const localChan = chanMgr.add(wrapper);
    if (localChan === -1) {
      reject(new Error('No free channels available'));
      return;
    }

    const MAX_WINDOW = 2 * 1024 * 1024;
    const PACKET_SIZE = 64 * 1024;
    proto.openssh_authAgent(localChan, MAX_WINDOW, PACKET_SIZE);
  });
}

/** Establish ControlMaster SSH connection to target */
function establishControlMaster(
  targetUser: string,
  targetHost: string,
  targetPort: number,
  controlPath: string,
  agentSocketPath?: string
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

    const env = { ...process.env };
    if (agentSocketPath) env.SSH_AUTH_SOCK = agentSocketPath;

    const proc = spawn('ssh', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
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
  keyFingerprint: string,
  agentForwardingAccepted: boolean
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
  const agentSocketPath = `/tmp/clawdfather-agent-${sessionId}`;

  let agentServer: NetServer | null = null;

  if (agentForwardingAccepted) {
    try {
      agentServer = createNetServer((localSocket) => {
        openAgentChannel(client).then((agentStream) => {
          localSocket.pipe(agentStream as any);
          (agentStream as any).pipe(localSocket);
          localSocket.on('close', () => { try { (agentStream as any).destroy(); } catch {} });
          (agentStream as any).on('close', () => { try { localSocket.destroy(); } catch {} });
          localSocket.on('error', () => { try { (agentStream as any).destroy(); } catch {} });
          (agentStream as any).on('error', () => { try { localSocket.destroy(); } catch {} });
        }).catch((err) => {
          console.error(`[clawdfather] Agent channel error: ${err.message}`);
          localSocket.destroy();
        });
      });

      await new Promise<void>((resolve, reject) => {
        agentServer!.on('error', (err) => {
          console.error(`[clawdfather] Agent socket server error: ${err.message}`);
          reject(err);
        });
        agentServer!.listen(agentSocketPath, () => resolve());
      });
      console.log(`[clawdfather] Agent proxy socket listening at ${agentSocketPath}`);
    } catch (err: any) {
      console.error(`[clawdfather] Failed to set up agent forwarding: ${err.message}`);
      // Continue without agent forwarding — will likely fail but won't crash
      agentServer = null;
    }
  }

  const success = await establishControlMaster(
    dest.user, dest.host, dest.port, controlPath,
    agentForwardingAccepted ? agentSocketPath : undefined
  );

  if (!success) {
    if (agentServer) {
      agentServer.close();
      try { unlinkSync(agentSocketPath); } catch {}
    }
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
  stream.write(`\x1b[90m  Target:  ${dest.user}@${dest.host}:${dest.port}\x1b[0m\r\n\r\n`);
  stream.write('\x1b[33m  Keep this SSH session open while using the web console.\x1b[0m\r\n');
  stream.write('\x1b[90m  Press Ctrl+C to end this session and revoke web access.\x1b[0m\r\n');

  let ended = false;
  function endSessionNow(reason: string): void {
    if (ended) return;
    ended = true;
    sessionStore.remove(sessionId);
    closeSessionClients(sessionId, 4001, 'SSH session ended');
    if (agentServer) {
      agentServer.close();
      try { unlinkSync(agentSocketPath); } catch {}
    }
    console.log(`[clawdfather] Session ${sessionId} invalidated (${reason})`);
  }

  client.once('close', () => endSessionNow('SSH client closed'));
  client.once('end', () => endSessionNow('SSH client ended'));
  client.once('error', () => endSessionNow('SSH client error'));
}

/** Start the Clawdfather SSH server */
export function startSSHServer(config: ClawdfatherConfig): Server {
  const keyPath = config.hostKeyPath || join(__dirname, '..', 'keys', 'host_ed25519');
  const hostKey = ensureHostKey(keyPath);

  const server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
    console.log('[clawdfather] Client connected');

    let keyFingerprint = '';

    try {
      client.on('authentication', (ctx) => {
        try {
          if (ctx.method === 'publickey') {
            const fingerprint = createHash('sha256').update(ctx.key.data).digest('base64');
            keyFingerprint = `SHA256:${fingerprint}`;
            console.log(`[clawdfather] Public key auth from ${ctx.username}: ${keyFingerprint}`);
            ctx.accept();
          } else if (ctx.method === 'none') {
            ctx.reject(['publickey']);
          } else {
            ctx.reject(['publickey']);
          }
        } catch (err: any) {
          console.error(`[clawdfather] Auth handler error: ${err.message}`);
          try { ctx.reject(); } catch {}
        }
      });

      client.on('ready', () => {
        console.log('[clawdfather] Client authenticated');

        client.on('session', (accept) => {
          const session = accept();
          let agentForwardingAccepted = false;

          session.on('auth-agent', (accept) => {
            try {
              accept();
              agentForwardingAccepted = true;
              console.log('[clawdfather] Agent forwarding accepted');
            } catch (err: any) {
              console.error(`[clawdfather] Agent forwarding accept error: ${err.message}`);
            }
          });

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
                  handleInput(stream, inputBuffer, client, config, keyFingerprint, agentForwardingAccepted)
                    .catch((err: any) => {
                      console.error(`[clawdfather] handleInput error: ${err.message}`);
                      try {
                        stream.write(`\x1b[31m  ✗ Internal error: ${err.message}\x1b[0m\r\n`);
                        stream.write('\x1b[32m  ➜ \x1b[0m');
                      } catch {}
                    });
                  inputBuffer = '';
                  return;
                } else if (char === '\x7f' || char === '\b') {
                  if (inputBuffer.length > 0) {
                    inputBuffer = inputBuffer.slice(0, -1);
                    stream.write('\b \b');
                  }
                } else if (char === '\x03') {
                  stream.write('\r\n\x1b[33m  Goodbye!\x1b[0m\r\n');
                  try { stream.close(); } catch {}
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
    } catch (err: any) {
      console.error(`[clawdfather] Client setup error: ${err.message}`);
    }

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
