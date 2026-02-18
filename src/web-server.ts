import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";
import { WebSocketServer, WebSocket } from "ws";
import { sessionStore } from "./sessions";
import type { ClawdfatherConfig } from "./types";

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
 * Start the Clawdfather web server (HTTP + WebSocket).
 */
export function startWebServer(
  config: ClawdfatherConfig,
  pluginRoot: string,
  onInbound: (sessionId: string, text: string, keyFingerprint: string) => Promise<void>
): HttpServer {
  const port = config.webPort ?? 3000;
  const uiDir = join(pluginRoot, "ui");

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? "/";

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
          controlPath: session.controlPath,
          connectedAt: session.connectedAt,
          keyFingerprint: session.keyFingerprint,
        }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Session not found or expired" }));
      }
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
      // SPA fallback
      filePath = join(uiDir, "index.html");
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

  wss.on("connection", (ws: WebSocket) => {
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

        // Send session info back
        ws.send(JSON.stringify({
          type: "session",
          sessionId: session.sessionId,
          targetUser: session.targetUser,
          targetHost: session.targetHost,
          targetPort: session.targetPort,
          controlPath: session.controlPath,
          keyFingerprint: session.keyFingerprint,
        }));

        return;
      }

      if (msg.type === "message") {
        if (!authenticatedSessionId) {
          ws.send(JSON.stringify({ type: "error", message: "Not authenticated. Send auth first." }));
          return;
        }

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

  return server;
}
