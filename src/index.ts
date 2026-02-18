import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { startSSHServer } from './ssh-server';
import { sessionStore } from './sessions';
import { sshExec, sshUpload, sshDownload } from './ssh-exec';
import { ClawfatherConfig } from './types';

const DEFAULT_CONFIG: ClawfatherConfig = {
  sshPort: 2222,
  webDomain: 'localhost',
  sessionTimeoutMs: 1800000,
};

// ── Load Configuration ──────────────────────────────────────────────────────

function loadConfig(): ClawfatherConfig {
  const config = { ...DEFAULT_CONFIG };
  if (process.env.CLAWFATHER_SSH_PORT) config.sshPort = parseInt(process.env.CLAWFATHER_SSH_PORT, 10);
  if (process.env.CLAWFATHER_WEB_DOMAIN) config.webDomain = process.env.CLAWFATHER_WEB_DOMAIN;
  if (process.env.CLAWFATHER_SESSION_TIMEOUT) config.sessionTimeoutMs = parseInt(process.env.CLAWFATHER_SESSION_TIMEOUT, 10);
  if (process.env.CLAWFATHER_HOST_KEY_PATH) config.hostKeyPath = process.env.CLAWFATHER_HOST_KEY_PATH;
  return config;
}

// ── MIME types ──────────────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

// ── Web UI HTTP Server ──────────────────────────────────────────────────────

function startWebServer(config: ClawfatherConfig): http.Server {
  const uiDir = path.join(__dirname, '..', 'ui');

  const server = http.createServer((req, res) => {
    // API: session info
    if (req.url?.startsWith('/api/session/')) {
      const sessionId = req.url.replace('/api/session/', '');
      const session = sessionStore.get(sessionId);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (session) {
        res.writeHead(200);
        res.end(JSON.stringify({
          sessionId: session.sessionId, targetHost: session.targetHost,
          targetUser: session.targetUser, targetPort: session.targetPort,
          connectedAt: session.connectedAt,
        }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Session not found or expired' }));
      }
      return;
    }

    // API: execute command
    if (req.url === '/api/exec' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk; });
      req.on('end', async () => {
        try {
          const { sessionId, command, timeoutMs } = JSON.parse(body);
          const result = await sshExec(sessionId, command, timeoutMs);
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.writeHead(200);
          res.end(JSON.stringify(result));
        } catch (err: unknown) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      });
      return;
    }

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.writeHead(204);
      res.end();
      return;
    }

    // Static files
    let filePath = req.url === '/' ? '/index.html' : req.url || '/index.html';
    filePath = path.join(uiDir, filePath);
    if (!filePath.startsWith(uiDir)) { res.writeHead(403); res.end('Forbidden'); return; }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          fs.readFile(path.join(uiDir, 'index.html'), (_err2, data2) => {
            if (_err2) { res.writeHead(500); res.end('Internal Server Error'); return; }
            res.setHeader('Content-Type', 'text/html');
            res.writeHead(200);
            res.end(data2);
          });
        } else { res.writeHead(500); res.end('Internal Server Error'); }
        return;
      }
      res.setHeader('Content-Type', contentType);
      res.writeHead(200);
      res.end(data);
    });
  });

  server.listen(8080, '0.0.0.0', () => {
    console.log('[clawfather] Web UI server listening on port 8080');
  });

  return server;
}

// ── Tool Registration ───────────────────────────────────────────────────────

function registerTools() {
  return {
    ssh_exec: {
      name: 'ssh_exec',
      description: 'Execute a shell command on the connected remote server via SSH',
      parameters: {
        type: 'object', required: ['sessionId', 'command'],
        properties: {
          sessionId: { type: 'string', description: 'The active session ID' },
          command: { type: 'string', description: 'Shell command to execute' },
          timeoutMs: { type: 'number', description: 'Timeout in ms (default: 120000)' },
        },
      },
      handler: async (params: { sessionId: string; command: string; timeoutMs?: number }) => {
        return sshExec(params.sessionId, params.command, params.timeoutMs);
      },
    },
    ssh_upload: {
      name: 'ssh_upload',
      description: 'Upload a file to the connected remote server via SCP',
      parameters: {
        type: 'object', required: ['sessionId', 'localPath', 'remotePath'],
        properties: {
          sessionId: { type: 'string' }, localPath: { type: 'string' }, remotePath: { type: 'string' },
        },
      },
      handler: async (params: { sessionId: string; localPath: string; remotePath: string }) => {
        return sshUpload(params.sessionId, params.localPath, params.remotePath);
      },
    },
    ssh_download: {
      name: 'ssh_download',
      description: 'Download a file from the connected remote server via SCP',
      parameters: {
        type: 'object', required: ['sessionId', 'remotePath', 'localPath'],
        properties: {
          sessionId: { type: 'string' }, remotePath: { type: 'string' }, localPath: { type: 'string' },
        },
      },
      handler: async (params: { sessionId: string; remotePath: string; localPath: string }) => {
        return sshDownload(params.sessionId, params.remotePath, params.localPath);
      },
    },
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  console.log('[clawfather] Starting Clawfather...');
  const config = loadConfig();

  sessionStore.start(config.sessionTimeoutMs);
  const sshServer = startSSHServer(config);
  const webServer = startWebServer(config);
  const tools = registerTools();
  console.log(`[clawfather] Registered ${Object.keys(tools).length} agent tools`);

  const shutdown = () => {
    console.log('\n[clawfather] Shutting down...');
    sessionStore.stop();
    sshServer.close();
    webServer.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('[clawfather] Ready.');
  console.log(`[clawfather]   SSH: ssh -A -p ${config.sshPort} clawfather@localhost`);
  console.log('[clawfather]   Web: http://localhost:8080');
}

export { registerTools, sessionStore };
export { sshExec, sshUpload, sshDownload } from './ssh-exec';

if (require.main === module) {
  main();
}
