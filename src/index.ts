/**
 * Clawfather — OpenClaw Plugin Entry Point
 *
 * Registers:
 *  - SSH server as a background service
 *  - Gateway RPC: clawfather.sessions, clawfather.session
 *  - Gateway HTTP handler to serve the web UI
 *
 * The agent uses native OpenClaw `exec` tool with SSH ControlMaster
 * prefix for all server commands — no custom tools needed.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { sessionStore } from "./sessions";
import { startSSHServer } from "./ssh-server";
import type { ClawfatherConfig } from "./types";

// Resolve plugin root for serving static UI files
const PLUGIN_ROOT = typeof __dirname !== "undefined"
  ? __dirname.replace(/[/\\]src$/, "").replace(/[/\\]dist$/, "")
  : ".";

export default function register(api: any) {
  const config: ClawfatherConfig = {
    sshPort: 22,
    webDomain: "localhost",
    sessionTimeoutMs: 1800000,
    ...api.config?.plugins?.entries?.clawfather?.config,
  };
  let sshServer: any = null;

  // ── Background Service ──────────────────────────────────────────────
  api.registerService({
    id: "clawfather-ssh",
    start: () => {
      sessionStore.start(config.sessionTimeoutMs);
      sshServer = startSSHServer(config);
      api.logger.info("[clawfather] Service started");
    },
    stop: () => {
      sessionStore.stop();
      if (sshServer) {
        sshServer.close();
        sshServer = null;
      }
      api.logger.info("[clawfather] Service stopped");
    },
  });

  // ── Gateway RPC: session list ───────────────────────────────────────
  api.registerGatewayMethod("clawfather.sessions", ({ respond }: any) => {
    const list = sessionStore.list().map((s) => ({
      id: s.sessionId,
      target: `${s.targetUser}@${s.targetHost}:${s.targetPort}`,
      controlPath: s.controlPath,
      connectedAt: s.connectedAt,
      lastActivity: s.lastActivity,
    }));
    respond(true, { sessions: list });
  });

  // ── Gateway RPC: single session info ────────────────────────────────
  api.registerGatewayMethod("clawfather.session", ({ params, respond }: any) => {
    const session = sessionStore.get(params?.sessionId);
    if (!session) {
      respond(false, { error: "Session not found or expired" });
      return;
    }
    sessionStore.touch(session.sessionId);
    respond(true, {
      id: session.sessionId,
      targetUser: session.targetUser,
      targetHost: session.targetHost,
      targetPort: session.targetPort,
      controlPath: session.controlPath,
      connectedAt: session.connectedAt,
      lastActivity: session.lastActivity,
    });
  });

  // ── Gateway HTTP: serve web UI ──────────────────────────────────────
  const MIME: Record<string, string> = {
    html: "text/html", css: "text/css", js: "application/javascript",
  };

  api.registerGatewayHttp?.({
    path: "/clawfather",
    handler: (req: any, res: any) => {
      const uiDir = join(PLUGIN_ROOT, "ui");
      const url = (req.url ?? "").replace(/^\/clawfather\/?/, "") || "index.html";
      const safe = url.replace(/[^a-zA-Z0-9._-]/g, "");

      if (!["index.html", "style.css", "app.js"].includes(safe)) {
        serveFile(join(uiDir, "index.html"), "html", res);
        return;
      }

      const ext = safe.split(".").pop() ?? "html";
      serveFile(join(uiDir, safe), ext, res);
    },
  });

  function serveFile(filePath: string, ext: string, res: any) {
    try {
      const content = readFileSync(filePath, "utf-8");
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "text/plain" });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not Found");
    }
  }
}
