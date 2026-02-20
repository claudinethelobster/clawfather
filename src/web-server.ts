import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";
import { WebSocketServer, WebSocket } from "ws";
import { sessionStore } from "./sessions";
import type { ClawdfatherConfig, Account, AccountToken } from "./types";
import type { AccountStore } from "./account-store";
import { StripePayments } from "./stripe-payments";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
};

/** Map of sessionId → Set of connected WebSocket clients */
const wsClients = new Map<string, Set<WebSocket>>();

/**
 * Send a message to all WebSocket clients connected to a session.
 */
export function sendToSession(sessionId: string, data: Record<string, unknown>): void {
  const clients = wsClients.get(sessionId);
  if (!clients) return;
  const json = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    }
  }
}

/**
 * Immediately close all WebSocket clients for a session and remove the map entry.
 */
export function closeSessionClients(
  sessionId: string,
  code: number = 4001,
  reason: string = 'Session expired',
): void {
  const clients = wsClients.get(sessionId);
  if (!clients) return;
  for (const ws of clients) {
    try { ws.close(code, reason); } catch { /* already closed */ }
  }
  wsClients.delete(sessionId);
}

// Singleton state for the web server so multiple accounts don't cause EADDRINUSE
let singletonServer: HttpServer | null = null;
let singletonRefCount = 0;

/** Compute the CORS origin value for a response. */
function resolveAllowedOrigin(reqOrigin: string | undefined, config: ClawdfatherConfig): string | null {
  const allowed = config.allowedOrigins;
  if (!allowed || allowed.length === 0) {
    // Default: same-origin only — reflect the request origin if it matches
    // the configured webDomain, otherwise reject.
    if (!reqOrigin) return null;
    try {
      const url = new URL(reqOrigin);
      if (url.hostname === config.webDomain || url.hostname === "localhost") {
        return reqOrigin;
      }
    } catch { /* malformed origin */ }
    return null;
  }
  if (allowed.includes("*")) return "*";
  if (reqOrigin && allowed.includes(reqOrigin)) return reqOrigin;
  return null;
}

/**
 * Get or create the singleton Clawdfather web server (HTTP + WebSocket).
 * Returns an object with a release() method for reference-counted shutdown.
 */
let _stripePayments: StripePayments | null = null;
function getStripePayments(config: ClawdfatherConfig, store: AccountStore): StripePayments {
  if (!_stripePayments) {
    _stripePayments = new StripePayments(store, config);
  }
  return _stripePayments;
}

function getAuthenticatedAccount(
  req: IncomingMessage,
  store: AccountStore,
): { account: Account; tokenRecord: AccountToken } | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;
  return store.getAccountByToken(token) ?? null;
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

function formatBalance(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export function startWebServer(
  config: ClawdfatherConfig,
  pluginRoot: string,
  onInbound: (sessionId: string, text: string, keyFingerprint: string) => Promise<void>,
  accountStore?: AccountStore,
): { server: HttpServer; release: () => void } {
  if (singletonServer) {
    singletonRefCount++;
    return {
      server: singletonServer,
      release: () => {
        singletonRefCount--;
        if (singletonRefCount <= 0 && singletonServer) {
          singletonServer.close();
          singletonServer = null;
          singletonRefCount = 0;
        }
      },
    };
  }

  const port = config.webPort ?? 3000;
  const uiDir = join(pluginRoot, "ui");

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // CORS headers — configurable allowlist, same-origin by default
    const reqOrigin = req.headers.origin;
    const allowedOrigin = resolveAllowedOrigin(reqOrigin, config);
    if (allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? "/";

    // API: version
    if (url === "/api/version") {
      let commitHash = "unknown";
      try {
        const { execSync } = require("child_process");
        commitHash = execSync("git rev-parse --short HEAD", { cwd: pluginRoot, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
      } catch {}
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ version: "0.1.0", commit: commitHash }));
      return;
    }

    // API: session info
    if (url.startsWith("/api/session/")) {
      const sessionId = url.replace("/api/session/", "").split("?")[0];
      const session = sessionStore.get(sessionId);
      res.setHeader("Content-Type", "application/json");
      if (session) {
        sessionStore.touch(session.sessionId);
        res.writeHead(200);
        res.end(JSON.stringify({
          sessionId: session.sessionId,
          targetHost: session.targetHost,
          targetUser: session.targetUser,
          targetPort: session.targetPort,
          connectedAt: session.connectedAt,
          keyFingerprint: session.keyFingerprint,
        }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Session not found or expired" }));
      }
      return;
    }

    // --- Stripe webhook (raw body, no auth) ---
    if (url === '/api/webhooks/stripe' && req.method === 'POST') {
      if (!accountStore) {
        jsonResponse(res, 503, { error: 'Account system not available' });
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', async () => {
        const rawBody = Buffer.concat(chunks);
        const signature = req.headers['stripe-signature'] as string;
        if (!signature) {
          jsonResponse(res, 400, { error: 'Missing stripe-signature header' });
          return;
        }
        try {
          const payments = getStripePayments(config, accountStore);
          const result = await payments.handleWebhook(rawBody, signature);
          jsonResponse(res, 200, { received: true, ...result });
        } catch (err: any) {
          console.error(`[clawdfather] Stripe webhook error: ${err.message}`);
          jsonResponse(res, 400, { error: err.message });
        }
      });
      return;
    }

    // --- Account API: GET /api/account/me ---
    if (url === '/api/account/me' && req.method === 'GET') {
      if (!accountStore) {
        jsonResponse(res, 503, { error: 'Account system not available' });
        return;
      }
      const auth = getAuthenticatedAccount(req, accountStore);
      if (!auth) {
        jsonResponse(res, 401, { error: 'Unauthorized' });
        return;
      }
      const keys = accountStore.getKeysForAccount(auth.account.accountId);
      jsonResponse(res, 200, {
        accountId: auth.account.accountId,
        creditsSec: auth.account.creditsSec,
        balanceFormatted: formatBalance(auth.account.creditsSec),
        tokenExpiresAt: auth.tokenRecord.expiresAt,
        keys: keys.map((k) => ({
          keyId: k.keyId,
          fingerprint: k.fingerprint,
          label: k.label,
          addedAt: k.addedAt,
        })),
      });
      return;
    }

    // --- Account API: POST /api/account/token/refresh ---
    if (url === '/api/account/token/refresh' && req.method === 'POST') {
      if (!accountStore) {
        jsonResponse(res, 503, { error: 'Account system not available' });
        return;
      }
      const auth = getAuthenticatedAccount(req, accountStore);
      if (!auth) {
        jsonResponse(res, 401, { error: 'Unauthorized' });
        return;
      }
      const oldTokenId = auth.tokenRecord.tokenId;
      const ttlMs = config.tokenTtlMs ?? 15 * 60 * 1000;
      const newToken = accountStore.issueToken(
        auth.account.accountId,
        auth.tokenRecord.sessionId,
        ttlMs,
      );
      accountStore.revokeToken(oldTokenId);
      jsonResponse(res, 200, {
        token: newToken.token,
        expiresAt: newToken.expiresAt,
      });
      return;
    }

    // --- Account API: POST /api/account/keys/add ---
    if (url === '/api/account/keys/add' && req.method === 'POST') {
      if (!accountStore) {
        jsonResponse(res, 503, { error: 'Account system not available' });
        return;
      }
      const auth = getAuthenticatedAccount(req, accountStore);
      if (!auth) {
        jsonResponse(res, 401, { error: 'Unauthorized' });
        return;
      }
      const _store = accountStore;
      const _account = auth.account;
      readJsonBody(req).then((body) => {
        const fingerprint = body?.fingerprint as string | undefined;
        if (
          !fingerprint ||
          typeof fingerprint !== 'string' ||
          !fingerprint.startsWith('SHA256:') ||
          fingerprint.length < 10
        ) {
          jsonResponse(res, 400, {
            error: 'Invalid fingerprint. Must start with "SHA256:" and be a valid key fingerprint.',
          });
          return;
        }
        const existingKeys = _store.getKeysForAccount(_account.accountId);
        if (existingKeys.some((k) => k.fingerprint === fingerprint)) {
          jsonResponse(res, 400, { error: 'Fingerprint already associated with this account' });
          return;
        }
        const key = _store.addKey(_account.accountId, fingerprint, body.label);
        jsonResponse(res, 200, { key });
      }).catch((err: any) => {
        jsonResponse(res, 400, { error: err.message });
      });
      return;
    }

    // --- Account API: DELETE /api/account/keys/:keyId ---
    if (url.startsWith('/api/account/keys/') && req.method === 'DELETE') {
      if (!accountStore) {
        jsonResponse(res, 503, { error: 'Account system not available' });
        return;
      }
      const auth = getAuthenticatedAccount(req, accountStore);
      if (!auth) {
        jsonResponse(res, 401, { error: 'Unauthorized' });
        return;
      }
      const keyId = url.replace('/api/account/keys/', '').split('?')[0];
      const keys = accountStore.getKeysForAccount(auth.account.accountId);
      if (!keys.some((k) => k.keyId === keyId)) {
        jsonResponse(res, 404, { error: 'Key not found or does not belong to this account' });
        return;
      }
      const result = accountStore.removeKey(keyId);
      jsonResponse(res, result.removed ? 200 : 400, result);
      return;
    }

    // --- Account API: POST /api/account/checkout ---
    if (url === '/api/account/checkout' && req.method === 'POST') {
      if (!accountStore) {
        jsonResponse(res, 503, { error: 'Account system not available' });
        return;
      }
      const auth = getAuthenticatedAccount(req, accountStore);
      if (!auth) {
        jsonResponse(res, 401, { error: 'Unauthorized' });
        return;
      }
      const _store = accountStore;
      const _accountId = auth.account.accountId;
      readJsonBody(req).then(async (body) => {
        const payments = getStripePayments(config, _store);
        const hours = Math.min(Math.max(Math.floor(body?.hours ?? 1), 1), 24);
        const protocol = config.webDomain === 'localhost' ? 'http' : 'https';
        const baseUrl = `${protocol}://${config.webDomain}`;
        const { url: checkoutUrl } = await payments.createCheckoutSession({
          accountId: _accountId,
          hours,
          successUrl: `${baseUrl}/?payment=success`,
          cancelUrl: `${baseUrl}/?payment=cancelled`,
        });
        jsonResponse(res, 200, { checkoutUrl });
      }).catch((err: any) => {
        if (err.message.includes('Stripe secret key not configured')) {
          jsonResponse(res, 503, { error: 'Stripe payments not configured' });
        } else {
          console.error(`[clawdfather] Checkout error: ${err.message}`);
          jsonResponse(res, 500, { error: 'Failed to create checkout session' });
        }
      });
      return;
    }

    // Static files
    let filePath: string;
    if (url === "/" || url === "/index.html") {
      filePath = join(uiDir, "index.html");
    } else {
      // Sanitize: only allow files in uiDir
      const clean = url.split("?")[0].replace(/\.\./g, "");
      filePath = join(uiDir, clean);
    }

    if (!filePath.startsWith(uiDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (!existsSync(filePath)) {
      // Serve account.html for /account path
      const cleanUrl = (req.url ?? "/").split("?")[0].replace(/\.\./g, "");
      if (cleanUrl === "/account") {
        filePath = join(uiDir, "account.html");
      } else {
        // SPA fallback
        filePath = join(uiDir, "index.html");
      }
    }

    try {
      const content = readFileSync(filePath);
      const ext = extname(filePath);
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
      res.end(content);
    } catch {
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  });

  // WebSocket server
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const wsOrigin = req.headers.origin;
    // Explicit WS origin enforcement: require an Origin header and validate
    // against the same allowlist policy used for HTTP CORS.
    if (!wsOrigin) {
      ws.close(4003, "Origin required");
      return;
    }
    const allowed = resolveAllowedOrigin(wsOrigin, config);
    if (!allowed) {
      ws.close(4003, "Origin not allowed");
      return;
    }

    let authenticatedSessionId: string | null = null;
    let keyFingerprint = "unknown";

    ws.on("message", async (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      if (msg.type === "auth") {
        const sessionId = msg.sessionId as string;
        if (!sessionId) {
          ws.send(JSON.stringify({ type: "error", message: "Missing sessionId" }));
          return;
        }

        const session = sessionStore.get(sessionId);
        if (!session) {
          ws.send(JSON.stringify({ type: "error", message: "Session not found or expired" }));
          return;
        }

        authenticatedSessionId = sessionId;
        keyFingerprint = session.keyFingerprint;

        // Register this WS connection for the session
        if (!wsClients.has(sessionId)) {
          wsClients.set(sessionId, new Set());
        }
        wsClients.get(sessionId)!.add(ws);

        // Send session info back (controlPath kept server-side only)
        ws.send(JSON.stringify({
          type: "session",
          sessionId: session.sessionId,
          targetUser: session.targetUser,
          targetHost: session.targetHost,
          targetPort: session.targetPort,
          keyFingerprint: session.keyFingerprint,
        }));

        return;
      }

      if (msg.type === "message") {
        if (!authenticatedSessionId) {
          ws.send(JSON.stringify({ type: "error", message: "Not authenticated. Send auth first." }));
          return;
        }

        // Re-validate session liveness on every message
        const liveSession = sessionStore.get(authenticatedSessionId);
        if (!liveSession) {
          ws.send(JSON.stringify({ type: "error", message: "Session expired or invalidated" }));
          ws.close(4001, "Session expired");
          return;
        }
        sessionStore.touch(authenticatedSessionId);

        const text = (msg.text as string)?.trim();
        if (!text) return;

        // Dispatch through OpenClaw channel system
        try {
          sendToSession(authenticatedSessionId, { type: "status", status: "thinking" });
          await onInbound(authenticatedSessionId, text, keyFingerprint);
          sendToSession(authenticatedSessionId, { type: "status", status: "done" });
        } catch (err: any) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
          sendToSession(authenticatedSessionId, { type: "status", status: "done" });
        }

        return;
      }

      ws.send(JSON.stringify({ type: "error", message: `Unknown message type: ${msg.type}` }));
    });

    ws.on("close", () => {
      if (authenticatedSessionId) {
        const clients = wsClients.get(authenticatedSessionId);
        if (clients) {
          clients.delete(ws);
          if (clients.size === 0) {
            wsClients.delete(authenticatedSessionId);
          }
        }
      }
    });
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[clawdfather] Web server listening on port ${port}`);
  });

  singletonServer = server;
  singletonRefCount = 1;

  return {
    server,
    release: () => {
      singletonRefCount--;
      if (singletonRefCount <= 0 && singletonServer) {
        singletonServer.close();
        singletonServer = null;
        singletonRefCount = 0;
      }
    },
  };
}
