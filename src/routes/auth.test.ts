import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'http';

// ── Helpers extracted for testability ────────────────────────────────

function parseSessionTokenFromCookie(cookieHeader: string): string | null {
  const match = cookieHeader.split(';').map(s => s.trim()).find(s => s.startsWith('session_token='));
  return match ? match.slice('session_token='.length) : null;
}

function detectWantsJson(acceptHeader: string | undefined, modeParam: string | null): boolean {
  return (acceptHeader ?? '').includes('application/json') || modeParam === 'json';
}

function buildBaseUrl(webDomain: string, webPort?: number): string {
  if (webDomain.startsWith('localhost') || webDomain.startsWith('127.')) {
    return `http://${webDomain.includes(':') ? webDomain : `${webDomain}:${webPort ?? 3000}`}/`;
  }
  return `https://${webDomain}/`;
}

function isSecureDomain(forwardedProto: string | undefined, webDomain: string): boolean {
  return forwardedProto === 'https' || (!webDomain.startsWith('localhost') && !webDomain.startsWith('127.'));
}

// ── Mock factory ─────────────────────────────────────────────────────

function createMockReq(opts: {
  url?: string;
  method?: string;
  headers?: Record<string, string | undefined>;
}): IncomingMessage {
  return {
    url: opts.url ?? '/',
    method: opts.method ?? 'GET',
    headers: opts.headers ?? {},
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;
}

function createMockRes(): ServerResponse & {
  _statusCode: number;
  _headers: Record<string, string>;
  _body: string;
  _ended: boolean;
} {
  const headers: Record<string, string> = {};
  let body = '';
  let ended = false;
  let statusCode = 200;
  const res = {
    get _statusCode() { return statusCode; },
    get _headers() { return headers; },
    get _body() { return body; },
    get _ended() { return ended; },
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
    getHeader(name: string) { return headers[name.toLowerCase()]; },
    writeHead(code: number, hdrs?: Record<string, string>) {
      statusCode = code;
      if (hdrs) Object.entries(hdrs).forEach(([k, v]) => { headers[k.toLowerCase()] = v; });
    },
    end(chunk?: string) {
      if (chunk) body += chunk;
      ended = true;
    },
    write(chunk: string) { body += chunk; },
  };
  return res as unknown as ReturnType<typeof createMockRes>;
}

// ── Tests: Cookie parsing ────────────────────────────────────────────

describe('parseSessionTokenFromCookie', () => {
  it('extracts token from single cookie', () => {
    assert.equal(parseSessionTokenFromCookie('session_token=abc123'), 'abc123');
  });

  it('extracts token from multiple cookies', () => {
    assert.equal(
      parseSessionTokenFromCookie('foo=bar; session_token=tok_xyz; other=val'),
      'tok_xyz',
    );
  });

  it('returns null when session_token not present', () => {
    assert.equal(parseSessionTokenFromCookie('foo=bar; baz=qux'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseSessionTokenFromCookie(''), null);
  });

  it('handles token with = signs in value', () => {
    assert.equal(
      parseSessionTokenFromCookie('session_token=abc=def=ghi'),
      'abc=def=ghi',
    );
  });
});

// ── Tests: wantsJson detection ───────────────────────────────────────

describe('detectWantsJson', () => {
  it('returns true for Accept: application/json', () => {
    assert.equal(detectWantsJson('application/json', null), true);
  });

  it('returns true when accept includes application/json among others', () => {
    assert.equal(detectWantsJson('text/html, application/json', null), true);
  });

  it('returns true for mode=json query param', () => {
    assert.equal(detectWantsJson(undefined, 'json'), true);
  });

  it('returns false for text/html without mode=json', () => {
    assert.equal(detectWantsJson('text/html', null), false);
  });

  it('returns false for undefined accept and null mode', () => {
    assert.equal(detectWantsJson(undefined, null), false);
  });
});

// ── Tests: Base URL construction ─────────────────────────────────────

describe('buildBaseUrl', () => {
  it('uses http for localhost', () => {
    assert.equal(buildBaseUrl('localhost', 3000), 'http://localhost:3000/');
  });

  it('uses http for 127.0.0.1', () => {
    assert.equal(buildBaseUrl('127.0.0.1', 8080), 'http://127.0.0.1:8080/');
  });

  it('defaults port to 3000 for localhost without port', () => {
    assert.equal(buildBaseUrl('localhost'), 'http://localhost:3000/');
  });

  it('preserves port if domain already contains one', () => {
    assert.equal(buildBaseUrl('localhost:9999', 3000), 'http://localhost:9999/');
  });

  it('uses https for production domain', () => {
    assert.equal(buildBaseUrl('app.example.com'), 'https://app.example.com/');
  });
});

// ── Tests: Secure flag detection ─────────────────────────────────────

describe('isSecureDomain', () => {
  it('returns true when x-forwarded-proto is https', () => {
    assert.equal(isSecureDomain('https', 'localhost'), true);
  });

  it('returns false for localhost without forwarded proto', () => {
    assert.equal(isSecureDomain(undefined, 'localhost'), false);
  });

  it('returns true for production domain', () => {
    assert.equal(isSecureDomain(undefined, 'app.example.com'), true);
  });

  it('returns false for 127.0.0.1 without forwarded proto', () => {
    assert.equal(isSecureDomain(undefined, '127.0.0.1'), false);
  });
});

// ── Integration-style: OAuth callback response modes ─────────────────

describe('OAuth callback response modes (mock)', () => {
  // We mock the DB-heavy handleOAuthGitHubCallback by testing the response
  // logic in isolation. The full function needs DB + GitHub API, but the
  // response branch is purely based on req/res/config.

  function simulateCallbackResponse(opts: {
    accept?: string;
    mode?: string;
    webDomain: string;
    webPort?: number;
    forwardedProto?: string;
  }) {
    const res = createMockRes();
    const token = 'test_session_token_abc';
    const acct = { id: 'acct_1', display_name: 'testuser', email: 'test@example.com' };
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const wantsJson = detectWantsJson(opts.accept, opts.mode ?? null);

    if (wantsJson) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token, account: acct, expires_at: expiresAt.toISOString() }));
    } else {
      const maxAge = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
      const secure = isSecureDomain(opts.forwardedProto, opts.webDomain);
      const secureFlag = secure ? '; Secure' : '';
      res.setHeader('Set-Cookie', `session_token=${token}; HttpOnly${secureFlag}; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
      const baseUrl = buildBaseUrl(opts.webDomain, opts.webPort);
      res.setHeader('Location', baseUrl);
      res.writeHead(302);
      res.end();
    }

    return { res, token, acct, expiresAt };
  }

  it('default browser flow -> 302 redirect with Set-Cookie', () => {
    const { res } = simulateCallbackResponse({ webDomain: 'localhost', webPort: 3000 });
    assert.equal(res._statusCode, 302);
    assert.ok(res._headers['set-cookie']?.includes('session_token='));
    assert.ok(res._headers['set-cookie']?.includes('HttpOnly'));
    assert.ok(!res._headers['set-cookie']?.includes('Secure'));
    assert.equal(res._headers['location'], 'http://localhost:3000/');
    assert.equal(res._body, '');
  });

  it('default browser flow with production domain -> Secure cookie', () => {
    const { res } = simulateCallbackResponse({ webDomain: 'app.clawdfather.com' });
    assert.equal(res._statusCode, 302);
    assert.ok(res._headers['set-cookie']?.includes('; Secure'));
    assert.equal(res._headers['location'], 'https://app.clawdfather.com/');
  });

  it('Accept: application/json -> 200 JSON body, no redirect', () => {
    const { res, token, acct } = simulateCallbackResponse({
      accept: 'application/json',
      webDomain: 'localhost',
    });
    assert.equal(res._statusCode, 200);
    assert.equal(res._headers['location'], undefined);
    const body = JSON.parse(res._body);
    assert.equal(body.token, token);
    assert.equal(body.account.id, acct.id);
  });

  it('mode=json query param -> 200 JSON body', () => {
    const { res } = simulateCallbackResponse({
      mode: 'json',
      webDomain: 'localhost',
    });
    assert.equal(res._statusCode, 200);
    const body = JSON.parse(res._body);
    assert.ok(body.token);
    assert.ok(body.account);
    assert.ok(body.expires_at);
  });

  it('localhost with x-forwarded-proto: https -> Secure cookie', () => {
    const { res } = simulateCallbackResponse({
      webDomain: 'localhost',
      webPort: 3000,
      forwardedProto: 'https',
    });
    assert.equal(res._statusCode, 302);
    assert.ok(res._headers['set-cookie']?.includes('; Secure'));
  });
});

// ── Integration-style: authenticate() cookie fallback ────────────────

describe('authenticate cookie fallback (mock)', () => {
  // We can't call authenticate() directly without a real DB, so we test
  // the token extraction logic that was added.

  function extractToken(req: IncomingMessage): string | null {
    let token: string | null = null;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else {
      const cookieHeader = (req.headers as Record<string, string | undefined>).cookie ?? '';
      const match = cookieHeader.split(';').map(s => s.trim()).find(s => s.startsWith('session_token='));
      if (match) token = match.slice('session_token='.length);
    }
    return token;
  }

  it('extracts token from Bearer header', () => {
    const req = createMockReq({ headers: { authorization: 'Bearer mytoken123' } });
    assert.equal(extractToken(req), 'mytoken123');
  });

  it('falls back to session_token cookie when no Bearer', () => {
    const req = createMockReq({ headers: { cookie: 'session_token=cookie_tok' } });
    assert.equal(extractToken(req), 'cookie_tok');
  });

  it('prefers Bearer over cookie', () => {
    const req = createMockReq({
      headers: { authorization: 'Bearer bearer_tok', cookie: 'session_token=cookie_tok' },
    });
    assert.equal(extractToken(req), 'bearer_tok');
  });

  it('returns null when neither Bearer nor cookie present', () => {
    const req = createMockReq({ headers: {} });
    assert.equal(extractToken(req), null);
  });

  it('returns null for non-Bearer auth header without cookie', () => {
    const req = createMockReq({ headers: { authorization: 'Basic abc' } });
    assert.equal(extractToken(req), null);
  });

  it('extracts cookie from multi-cookie header', () => {
    const req = createMockReq({
      headers: { cookie: 'theme=dark; session_token=tok_multi; lang=en' },
    });
    assert.equal(extractToken(req), 'tok_multi');
  });
});
