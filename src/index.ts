import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { startSSHServer } from './ssh-server';
import { sessionStore } from './sessions';
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
          controlPath: session.controlPath,
          connectedAt: session.connectedAt,
        }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Session not found or expired' }));
      }
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

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  console.log('[clawfather] Starting Clawfather...');
  const config = loadConfig();

  sessionStore.start(config.sessionTimeoutMs);
  const sshServer = startSSHServer(config);
  const webServer = startWebServer(config);
  console.log('[clawfather] Using native OpenClaw exec tool for SSH commands (no custom tools registered)');

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

export { sessionStore };

if (require.main === module) {
  main();
}
