/**
 * Tests for session route handlers: list, get, delete.
 * Uses node:test + node:assert with module-level mocking via require cache.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "http";

// ── Minimal mock helpers (same pattern as auth.test.ts) ─────────────────────

function mockReq(opts: {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  return {
    url: opts.url ?? "/api/v1/sessions",
    method: opts.method ?? "GET",
    headers: opts.headers ?? { authorization: "Bearer test-token" },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

interface MockRes {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  ended: boolean;
  headersSent: boolean;
  setHeader(name: string, value: string | string[]): void;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(data?: string): void;
  json(): unknown;
}

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 200,
    headers: {},
    body: "",
    ended: false,
    headersSent: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status, hdrs) {
      this.statusCode = status;
      if (hdrs) for (const [k, v] of Object.entries(hdrs)) this.headers[k.toLowerCase()] = v;
    },
    end(data?: string) { this.body = data ?? ""; this.ended = true; },
    json() { return JSON.parse(this.body); },
  };
  return r;
}

// ── DB mock state ───────────────────────────────────────────────────────────

let queryResults: Array<{ rows: Record<string, unknown>[] }> = [];
let queryCallIndex = 0;

function setQueryResults(...results: Array<{ rows: Record<string, unknown>[] }>) {
  queryResults = results;
  queryCallIndex = 0;
}

function mockQuery(_text: string, _params?: unknown[]) {
  const result = queryResults[queryCallIndex] ?? { rows: [] };
  queryCallIndex++;
  return Promise.resolve(result);
}

// ── Module-level mocking via require cache ──────────────────────────────────

const authAccount = {
  id: "acct-001",
  display_name: "Test User",
  email: "test@example.com",
  created_at: "2025-01-01T00:00:00Z",
  last_seen_at: "2025-02-20T00:00:00Z",
  is_active: true,
};

// Mock ../db
const dbMod = require("../db");
const originalQuery = dbMod.query;
dbMod.query = mockQuery;

// Mock ../auth-middleware
const authMod = require("../auth-middleware");
const originalAuthenticate = authMod.authenticate;
let authShouldFail = false;
authMod.authenticate = async (_req: IncomingMessage, res: ServerResponse) => {
  if (authShouldFail) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "unauthorized", message: "Missing or invalid auth token." } }));
    return null;
  }
  return { account: authAccount, tokenHash: "mock-hash" };
};

// Mock ../sessions (sessionStore)
const sessionsMod = require("../sessions");
const originalSessionStore = { ...sessionsMod.sessionStore };
sessionsMod.sessionStore.remove = (_id: string) => true;
sessionsMod.sessionStore.get = (_id: string) => undefined;

// Mock ../web-server (closeSessionClients)
const webServerMod = require("../web-server");
const originalClose = webServerMod.closeSessionClients;
webServerMod.closeSessionClients = () => {};

// Mock ../audit
const auditMod = require("../audit");
const originalAuditLog = auditMod.auditLog;
auditMod.auditLog = () => {};

// Now import the handlers (they'll pick up our mocked modules)
const { handleListSessions, handleGetSession, handleDeleteSession } = require("./sessions");

// ── Tests ───────────────────────────────────────────────────────────────────

describe("handleListSessions", () => {
  beforeEach(() => {
    authShouldFail = false;
    queryCallIndex = 0;
  });

  it("returns sessions with correct fields", async () => {
    setQueryResults(
      {
        rows: [
          {
            id: "sess-001",
            status: "active",
            agent_session_id: "ssh:sess-001",
            started_at: "2025-02-20T10:00:00Z",
            closed_at: null,
            close_reason: null,
            last_heartbeat_at: "2025-02-20T10:05:00Z",
            created_at: "2025-02-20T10:00:00Z",
            conn_id: "conn-001",
            conn_label: "My Server",
            conn_host: "192.168.1.100",
          },
        ],
      },
      { rows: [{ cnt: "1" }] },
    );

    const req = mockReq({ url: "/api/v1/sessions" });
    const res = mockRes();
    await handleListSessions(req, res);

    assert.equal(res.statusCode, 200);
    const data = res.json() as { sessions: unknown[]; total: number; limit: number; offset: number };
    assert.equal(data.sessions.length, 1);
    assert.equal(data.total, 1);
    assert.equal(data.limit, 20);
    assert.equal(data.offset, 0);

    const sess = data.sessions[0] as Record<string, unknown>;
    assert.equal(sess.id, "sess-001");
    assert.equal(sess.status, "active");
    const conn = sess.connection as Record<string, unknown>;
    assert.equal(conn.label, "My Server");
    assert.equal(conn.host, "192.168.1.100");
  });

  it("returns empty array when no sessions", async () => {
    setQueryResults(
      { rows: [] },
      { rows: [{ cnt: "0" }] },
    );

    const req = mockReq({ url: "/api/v1/sessions" });
    const res = mockRes();
    await handleListSessions(req, res);

    assert.equal(res.statusCode, 200);
    const data = res.json() as { sessions: unknown[]; total: number };
    assert.equal(data.sessions.length, 0);
    assert.equal(data.total, 0);
  });

  it("returns 401 when not authenticated", async () => {
    authShouldFail = true;
    const req = mockReq({ url: "/api/v1/sessions", headers: {} });
    const res = mockRes();
    await handleListSessions(req, res);

    assert.equal(res.statusCode, 401);
  });
});

describe("handleGetSession", () => {
  beforeEach(() => {
    authShouldFail = false;
    queryCallIndex = 0;
  });

  it("returns 404 for unknown session", async () => {
    setQueryResults({ rows: [] });

    const req = mockReq({ url: "/api/v1/sessions/nonexistent" });
    const res = mockRes();
    const config = { webDomain: "localhost", webPort: 3000 } as any;
    await handleGetSession(req, res, "nonexistent", config);

    assert.equal(res.statusCode, 404);
    const data = res.json() as { error: { code: string; message: string } };
    assert.equal(data.error.code, "not_found");
    assert.equal(data.error.message, "Session not found.");
  });

  it("returns session details for valid session", async () => {
    setQueryResults({
      rows: [
        {
          id: "sess-002",
          status: "active",
          agent_session_id: "ssh:sess-002",
          started_at: "2025-02-20T10:00:00Z",
          last_heartbeat_at: "2025-02-20T10:05:00Z",
          close_reason: null,
          conn_id: "conn-001",
          conn_label: "Prod Server",
          conn_host: "10.0.0.1",
          conn_port: 22,
          conn_username: "root",
        },
      ],
    });

    const req = mockReq({ url: "/api/v1/sessions/sess-002" });
    const res = mockRes();
    const config = { webDomain: "example.com", webPort: 443 } as any;
    await handleGetSession(req, res, "sess-002", config);

    assert.equal(res.statusCode, 200);
    const data = res.json() as { session: Record<string, unknown> };
    assert.equal(data.session.id, "sess-002");
    assert.equal(data.session.status, "active");
    const conn = data.session.connection as Record<string, unknown>;
    assert.equal(conn.label, "Prod Server");
    assert.equal(conn.host, "10.0.0.1");
    assert.equal(conn.username, "root");
    assert.ok((data.session.chat_url as string).includes("example.com"));
  });
});

describe("handleDeleteSession", () => {
  beforeEach(() => {
    authShouldFail = false;
    queryCallIndex = 0;
  });

  it("returns 404 for unknown session", async () => {
    setQueryResults({ rows: [] });

    const req = mockReq({ method: "DELETE", url: "/api/v1/sessions/nonexistent" });
    const res = mockRes();
    await handleDeleteSession(req, res, "nonexistent");

    assert.equal(res.statusCode, 404);
    const data = res.json() as { error: { code: string } };
    assert.equal(data.error.code, "not_found");
  });

  it("returns 200 idempotently for already-closed session", async () => {
    setQueryResults({
      rows: [
        {
          id: "sess-003",
          status: "closed",
          closed_at: "2025-02-20T11:00:00Z",
          close_reason: "user",
          conn_username: "root",
          conn_host: "10.0.0.1",
          conn_port: 22,
        },
      ],
    });

    const req = mockReq({ method: "DELETE", url: "/api/v1/sessions/sess-003" });
    const res = mockRes();
    await handleDeleteSession(req, res, "sess-003");

    assert.equal(res.statusCode, 200);
    const data = res.json() as { session: Record<string, unknown> };
    assert.equal(data.session.id, "sess-003");
    assert.equal(data.session.status, "closed");
    assert.equal(data.session.close_reason, "user");
  });

  it("returns 200 idempotently for error-status session", async () => {
    setQueryResults({
      rows: [
        {
          id: "sess-004",
          status: "error",
          closed_at: "2025-02-20T11:00:00Z",
          close_reason: "ssh_connect_failed",
          conn_username: "admin",
          conn_host: "10.0.0.2",
          conn_port: 22,
        },
      ],
    });

    const req = mockReq({ method: "DELETE", url: "/api/v1/sessions/sess-004" });
    const res = mockRes();
    await handleDeleteSession(req, res, "sess-004");

    assert.equal(res.statusCode, 200);
    const data = res.json() as { session: Record<string, unknown> };
    assert.equal(data.session.status, "error");
  });
});
