import { Server, Connection } from 'ssh2';
import { createHash } from 'crypto';
import { readFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { execSync, spawn } from 'child_process';

/** Get current git commit hash */
function getCommitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
  } catch { return 'unknown'; }
}
import { createServer as createNetServer, Server as NetServer } from 'net';
import { join, dirname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { sessionStore } from './sessions';
import { closeSessionClients } from './web-server';
import { ClawdfatherConfig, Session } from './types';
import { AccountStore } from './account-store';
import { CreditManager } from './credit-manager';

// ---------------------------------------------------------------------------
// Singleton account store & credit manager
// ---------------------------------------------------------------------------

let _accountStore: AccountStore | null = null;
let _creditManager: CreditManager | null = null;

export function initAccountStore(dbPath: string): AccountStore {
  if (!_accountStore) {
    _accountStore = AccountStore.open(dbPath);
    _creditManager = new CreditManager(_accountStore);
  }
  return _accountStore;
}

export function getAccountStore(): AccountStore {
  if (!_accountStore) throw new Error('AccountStore not initialized');
  return _accountStore;
}

export function startCreditManager(): void {
  _creditManager?.start();
}

export function stopCreditManager(): void {
  _creditManager?.stop();
}

/** ASCII art banner */
const BANNER = `\r
\x1b[91m                                                                                                    \x1b[0m\r
\x1b[91m                                                                            ###                     \x1b[0m\r
\x1b[91m                                                                          ###   ###                 \x1b[0m\r
\x1b[91m                                                                        #   ##### ##                \x1b[0m\r
\x1b[91m     ##################                                                ######  ### ##               \x1b[0m\r
\x1b[91m     ##################                                            ############  ##                 \x1b[0m\r
\x1b[91m     #### ##### #######                                         #####  ######### #                  \x1b[0m\r
\x1b[91m     #    #####   -####                                      .### ## ##########+                    \x1b[0m\r
\x1b[91m          #####    ####                                      ##           #####                     \x1b[0m\r
\x1b[91m          #####    #########  ##########           ###### ###  ## ########  ###                     \x1b[0m\r
\x1b[91m          #####    #########- ##########         ####### ##### # ########### #                      \x1b[0m\r
\x1b[91m          #####    #### -###- ####  ####         #       ######  ###########  #######               \x1b[0m\r
\x1b[91m          #####    #### ##### #### ##+##         #       ####   ## ####++### #############          \x1b[0m\r
\x1b[91m          #####    #### ##### #########          #       ###   ### ###+#####-      -#####           \x1b[0m\r
\x1b[91m          #####    #### ##### #######            #       #. ###### #######. .       #               \x1b[0m\r
\x1b[91m          #####    #### ##### #####              #        ######  #######   -       #    -          \x1b[0m\r
\x1b[91m          #####    #### ##### ####     #         #      ######   ######     .       #    +          \x1b[0m\r
\x1b[91m          #####    #### ##### ##+#######         #        +   #####         -       #    -          \x1b[0m\r
\x1b[91m         ######    #### ##### ##########         #        #        +        .       #    -         \x1b[0m\r
\x1b[91m        ##.   ##  #-  #  -  ##   ...             #        #        #        -       #    -          \x1b[0m\r
\x1b[91m                                                 #        +        +        .       #    -          \x1b[0m\r
\x1b[91m       #######    #                              #  ######.        #     #  -       #    -          \x1b[0m\r
\x1b[91m     ######### ####                              ##########        +  ####  .       #    +          \x1b[0m\r
\x1b[91m     #####  ## ####                           ####  ##  ###        #  ####  -       #    .          \x1b[0m\r
\x1b[91m     ####    # ####                            ###  ## ####     ####  ####  .       #    -          \x1b[0m\r
\x1b[91m     ####    # ####                            ###  ##    -      ###  ####  -       #    +          \x1b[0m\r
\x1b[91m     ####      ####                            .##  ##    +      ###  ###   .       #    -          \x1b[0m\r
\x1b[91m     ####      #### ######## #### ###  ### #######  ###########  #### ########  ########  #######   \x1b[0m\r
\x1b[91m     ####      #### ######## ###+ ###+ ### #######  ############ #### ######### ########  #######   \x1b[0m\r
\x1b[91m     ####      #### #    ### +### #### ### ###  ##  ##      #### ###  #### #### ###  ###  ###   #   \x1b[0m\r
\x1b[91m     ####      ####    #####  ### #### ##  ### ###  ##    ###### ###  #### #### ###  ###  #+#       \x1b[0m\r
\x1b[91m     ####      ####  #######  ###########  ### ###  ##  ######## ###  #### #### ########  ###       \x1b[0m\r
\x1b[91m     ####      #### #### ###  ###########  ### ###  ##  ### -### ###  #### #### #####     ###       \x1b[0m\r
\x1b[91m     ####      #### #### ###  ###########  ### ###  ##  ### #### ###  #### #### ###       ###       \x1b[0m\r
\x1b[91m     #####  ## #### #### ###   #### #####  #+# .##  ##  ### #### ###  #### #### ####   #  ###       \x1b[0m\r
\x1b[91m     ######### #### ########   #### ##+#+  #######  ##  ######## ###  #### #### ########  ###       \x1b[0m\r
\x1b[91m      ######## ####  ### ####  ####  ###   ############ ####+### #### #### ##### ####### #######    \x1b[0m\r
\x1b[91m                                                                                                    \x1b[0m\r
\x1b[91m                                                                                                    \x1b[0m\r
\r
\x1b[33m  🦞 CLAWDFATHER\x1b[0m\r
\x1b[90m  Secure AI-Powered Server Administration\x1b[0m\r
\x1b[90m  ──────────────────────────────────────────────────\x1b[0m\r
`;

const COMMIT_HASH = getCommitHash();

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

    const timeout = setTimeout(() => {
      reject(new Error('auth-agent channel open timeout'));
    }, 5000);

    const wrapper: any = (err: Error | undefined, stream: any) => {
      clearTimeout(timeout);
      if (err) reject(err);
      else {
        console.log('[clawdfather] auth-agent channel opened');
        resolve(stream);
      }
    };
    wrapper.type = 'auth-agent@openssh.com';

    const localChan = chanMgr.add(wrapper);
    if (localChan === -1) {
      clearTimeout(timeout);
      reject(new Error('No free channels available'));
      return;
    }

    const MAX_WINDOW = 2 * 1024 * 1024;
    const PACKET_SIZE = 64 * 1024;
    console.log('[clawdfather] opening auth-agent channel');
    try {
      proto.openssh_authAgent(localChan, MAX_WINDOW, PACKET_SIZE);
    } catch (err: any) {
      clearTimeout(timeout);
      try { chanMgr.remove(localChan); } catch {}
      reject(err);
    }
  });
}

/** Establish ControlMaster SSH connection to target */
function establishControlMaster(
  targetUser: string,
  targetHost: string,
  targetPort: number,
  controlPath: string,
  agentSocketPath?: string
): Promise<{ success: boolean; stderr: string }> {
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

    const done = (success: boolean) => {
      if (!success && stderr) {
        console.error(`[clawdfather] ControlMaster stderr: ${stderr.trim()}`);
      }
      resolve({ success, stderr: stderr.trim() });
    };

    // Check if socket appears within 10s
    const timer = setTimeout(() => {
      if (existsSync(controlPath)) {
        done(true);
      } else {
        proc.kill();
        done(false);
      }
    }, 10_000);

    proc.on('close', () => {
      clearTimeout(timer);
      done(existsSync(controlPath));
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      console.error(`[clawdfather] SSH spawn error: ${err.message}`);
      done(false);
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
  agentForwardingAccepted: boolean,
  accountId: string,
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
        console.log('[clawdfather] local process connected to agent proxy socket');
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

  let probeError = '';
  if (agentForwardingAccepted) {
    try {
      execSync('ssh-add -l', {
        env: { ...process.env, SSH_AUTH_SOCK: agentSocketPath },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5_000,
      });
      console.log(`[clawdfather] Agent probe (ssh-add -l) succeeded via ${agentSocketPath}`);
    } catch (err: any) {
      const msg = (err.stderr ? err.stderr.toString().trim() : err.message) || 'unknown error';
      probeError = msg;
      console.error(`[clawdfather] Agent probe (ssh-add -l) failed: ${msg}`);
    }
  }

  const cmResult = await establishControlMaster(
    dest.user, dest.host, dest.port, controlPath,
    agentForwardingAccepted ? agentSocketPath : undefined
  );

  if (!cmResult.success) {
    if (agentServer) {
      agentServer.close();
      try { unlinkSync(agentSocketPath); } catch {}
    }
    stream.write('\x1b[31m  ✗ Failed to connect. Check your credentials and agent forwarding.\x1b[0m\r\n');
    if (probeError) {
      stream.write(`\x1b[31m  ✗ Agent probe failed: ${probeError}\x1b[0m\r\n`);
    }
    if (cmResult.stderr) {
      stream.write(`\x1b[90m  SSH error: ${cmResult.stderr}\x1b[0m\r\n`);
    }
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

  const store = getAccountStore();
  store.startAccountSession(sessionId, accountId);
  const accountToken = store.issueToken(accountId, sessionId, config.tokenTtlMs);

  const protocol = config.webDomain === 'localhost' ? 'http' : 'https';
  const url = `${protocol}://${config.webDomain}/#session=${sessionId}&token=${accountToken.token}`;

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
    try {
      const s = getAccountStore();
      s.endAccountSession(sessionId);
      s.revokeTokensBySession(sessionId);
    } catch {}
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
export function startSSHServer(config: ClawdfatherConfig, dbPath?: string): Server {
  initAccountStore(dbPath || join(__dirname, '..', 'data', 'clawdfather.db'));
  startCreditManager();

  const keyPath = config.hostKeyPath || join(__dirname, '..', 'keys', 'host_ed25519');
  const hostKey = ensureHostKey(keyPath);

  const server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
    console.log('[clawdfather] Client connected');

    let keyFingerprint = '';
    let accountId = '';
    let isNewAccount = false;

    try {
      client.on('authentication', (ctx) => {
        try {
          if (ctx.method === 'publickey') {
            const fingerprint = createHash('sha256').update(ctx.key.data).digest('base64');
            keyFingerprint = `SHA256:${fingerprint}`;
            console.log(`[clawdfather] Public key auth from ${ctx.username}: ${keyFingerprint}`);

            const { account, isNew } = getAccountStore().resolveOrCreateAccount(keyFingerprint);
            accountId = account.accountId;
            isNewAccount = isNew;

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

          session.on('auth-agent', (...args: any[]) => {
            try {
              const maybeAccept = args[0];
              if (typeof maybeAccept === 'function') {
                maybeAccept();
              }
              agentForwardingAccepted = true;
              console.log('[clawdfather] Agent forwarding accepted');
            } catch (err: any) {
              console.error(`[clawdfather] Agent forwarding handler error: ${err.message}`);
            }
          });

          session.on('pty', (accept) => { accept(); });

          session.on('shell', (accept) => {
            const stream = accept();
            stream.write(BANNER);
            stream.write(`\x1b[90m  v0.1.0 (${COMMIT_HASH})\x1b[0m\r\n\r\n`);

            const fpShort = keyFingerprint.length > 20
              ? keyFingerprint.slice(0, 20) + '...'
              : keyFingerprint;

            if (isNewAccount) {
              stream.write(`\x1b[33m  Welcome, new account created\x1b[0m\r\n`);
            } else {
              stream.write(`\x1b[33m  Welcome back, ${fpShort}\x1b[0m\r\n`);
            }

            const balance = getAccountStore().getBalance(accountId);
            const balHours = Math.floor(balance / 3600);
            const balMinutes = Math.floor((balance % 3600) / 60);
            stream.write(`\x1b[90m  Balance: ${balHours}h ${balMinutes}m\x1b[0m\r\n\r\n`);

            if (balance <= 0) {
              const protocol = config.webDomain === 'localhost' ? 'http' : 'https';
              stream.write('\x1b[31m  You have no credits remaining.\x1b[0m\r\n');
              stream.write(`\x1b[90m  Purchase time at: ${protocol}://${config.webDomain}/\x1b[0m\r\n\r\n`);
            }

            stream.write('\x1b[36m  Where would you like to connect?\x1b[0m\r\n');
            stream.write('\x1b[90m  Format: user@hostname[:port]\x1b[0m\r\n');
            stream.write('\x1b[90m  Tip: ensure your key is loaded first — ssh-add <key>\x1b[0m\r\n\r\n');
            stream.write('\x1b[32m  ➜ \x1b[0m');

            let inputBuffer = '';

            stream.on('data', (data: Buffer) => {
              const str = data.toString();
              for (const char of str) {
                if (char === '\r' || char === '\n') {
                  stream.write('\r\n');
                  handleInput(stream, inputBuffer, client, config, keyFingerprint, agentForwardingAccepted, accountId)
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

  server.on('close', () => {
    stopCreditManager();
    try { _accountStore?.close(); } catch {}
    _accountStore = null;
    _creditManager = null;
  });

  return server;
}
