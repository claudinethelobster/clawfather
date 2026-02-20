import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore } from '../src/account-store';
import { CreditManager } from '../src/credit-manager';
import { sessionStore } from '../src/sessions';
import type { Session } from '../src/types';

const TEST_FINGERPRINT = 'SHA256:creditMgrTestKey123';

let store: AccountStore;
let manager: CreditManager;

function makeSession(sessionId: string): Session {
  return {
    sessionId,
    keyFingerprint: TEST_FINGERPRINT,
    targetHost: 'example.com',
    targetUser: 'root',
    targetPort: 22,
    controlPath: `/tmp/fake-${sessionId}`,
    connectedAt: Date.now(),
    lastActivity: Date.now(),
  };
}

beforeEach(() => {
  store = AccountStore.open(':memory:');
  sessionStore.start(1_800_000);
});

afterEach(() => {
  manager?.stop();
  sessionStore.stop();
  for (const s of sessionStore.list()) {
    sessionStore.remove(s.sessionId);
  }
  store.close();
});

// ---------------------------------------------------------------------------
// Debit tick
// ---------------------------------------------------------------------------

describe('CreditManager tick', () => {
  it('debits the correct number of seconds per tick', () => {
    const intervalMs = 30_000;
    manager = new CreditManager(store, intervalMs);

    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    store.addCredits(account.accountId, 3600, 'bonus', 'test');

    const session = makeSession('sess-debit-1');
    sessionStore.create(session);
    store.startAccountSession('sess-debit-1', account.accountId);

    manager.tick();

    assert.equal(store.getBalance(account.accountId), 3600 - 30);
  });

  it('updates last_debit_at on successful debit', () => {
    const intervalMs = 10_000;
    manager = new CreditManager(store, intervalMs);

    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    store.addCredits(account.accountId, 3600, 'bonus', 'test');

    const session = makeSession('sess-debit-tick');
    sessionStore.create(session);
    store.startAccountSession('sess-debit-tick', account.accountId);

    manager.tick();

    assert.equal(store.getAccountIdForSession('sess-debit-tick'), account.accountId);
  });

  it('ends session and removes from store when credits run out', () => {
    const intervalMs = 30_000;
    manager = new CreditManager(store, intervalMs);

    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    store.addCredits(account.accountId, 10, 'bonus', 'test');

    const session = makeSession('sess-exhaust');
    sessionStore.create(session);
    store.startAccountSession('sess-exhaust', account.accountId);

    manager.tick();

    assert.equal(sessionStore.get('sess-exhaust'), undefined);
    assert.equal(store.getAccountIdForSession('sess-exhaust'), undefined);
    assert.equal(store.getBalance(account.accountId), 10);
  });

  it('skips sessions without an account_sessions record', () => {
    const intervalMs = 30_000;
    manager = new CreditManager(store, intervalMs);

    const session = makeSession('sess-orphan');
    sessionStore.create(session);

    manager.tick();

    assert.ok(sessionStore.get('sess-orphan'));
  });
});

// ---------------------------------------------------------------------------
// Multi-session debit
// ---------------------------------------------------------------------------

describe('CreditManager multi-session debit', () => {
  it('debits once per active session (2 sessions = 2x debit)', () => {
    const intervalMs = 30_000;
    manager = new CreditManager(store, intervalMs);

    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    store.addCredits(account.accountId, 3600, 'bonus', 'test');

    const s1 = makeSession('sess-multi-1');
    const s2 = makeSession('sess-multi-2');
    sessionStore.create(s1);
    sessionStore.create(s2);
    store.startAccountSession('sess-multi-1', account.accountId);
    store.startAccountSession('sess-multi-2', account.accountId);

    manager.tick();

    assert.equal(store.getBalance(account.accountId), 3600 - 60);
  });

  it('ending one session does not affect the other', () => {
    const intervalMs = 30_000;
    manager = new CreditManager(store, intervalMs);

    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    store.addCredits(account.accountId, 3600, 'bonus', 'test');

    const s1 = makeSession('sess-dual-1');
    const s2 = makeSession('sess-dual-2');
    sessionStore.create(s1);
    sessionStore.create(s2);
    store.startAccountSession('sess-dual-1', account.accountId);
    store.startAccountSession('sess-dual-2', account.accountId);

    // End session 1
    sessionStore.remove('sess-dual-1');
    store.endAccountSession('sess-dual-1');

    manager.tick();

    // Only session 2 debited (30 seconds)
    assert.equal(store.getBalance(account.accountId), 3600 - 30);
    assert.ok(sessionStore.get('sess-dual-2'));
  });
});

// ---------------------------------------------------------------------------
// Stale session cleanup
// ---------------------------------------------------------------------------

describe('CreditManager cleanStaleSessions', () => {
  it('marks stale DB sessions as ended and revokes tokens', () => {
    const intervalMs = 30_000;
    manager = new CreditManager(store, intervalMs);

    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    store.addCredits(account.accountId, 3600, 'bonus', 'test');

    // Create a DB session but do NOT create an in-memory session
    store.startAccountSession('sess-stale-1', account.accountId);
    store.issueToken(account.accountId, 'sess-stale-1');

    const cleaned = manager.cleanStaleSessions();

    assert.equal(cleaned, 1);
    assert.equal(store.getAccountIdForSession('sess-stale-1'), undefined);
    assert.equal(store.getTokensBySession('sess-stale-1').length, 0);
  });

  it('does not clean sessions that exist in the sessionStore', () => {
    const intervalMs = 30_000;
    manager = new CreditManager(store, intervalMs);

    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    store.addCredits(account.accountId, 3600, 'bonus', 'test');

    const s = makeSession('sess-alive');
    sessionStore.create(s);
    store.startAccountSession('sess-alive', account.accountId);

    const cleaned = manager.cleanStaleSessions();

    assert.equal(cleaned, 0);
    assert.equal(store.getAccountIdForSession('sess-alive'), account.accountId);
  });

  it('is called at the start of each tick', () => {
    const intervalMs = 30_000;
    manager = new CreditManager(store, intervalMs);

    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    store.addCredits(account.accountId, 3600, 'bonus', 'test');

    // Stale session in DB only
    store.startAccountSession('sess-tick-stale', account.accountId);

    // Active session in both
    const s = makeSession('sess-tick-active');
    sessionStore.create(s);
    store.startAccountSession('sess-tick-active', account.accountId);

    manager.tick();

    // Stale session cleaned
    assert.equal(store.getAccountIdForSession('sess-tick-stale'), undefined);
    // Active session debited
    assert.equal(store.getBalance(account.accountId), 3600 - 30);
  });
});

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------

describe('CreditManager start/stop', () => {
  it('stop clears the timer', () => {
    manager = new CreditManager(store, 60_000);
    manager.start();
    manager.stop();
    // Calling stop again should be safe (idempotent)
    manager.stop();
  });

  it('start is idempotent', () => {
    manager = new CreditManager(store, 60_000);
    manager.start();
    manager.start();
    manager.stop();
  });
});

// ---------------------------------------------------------------------------
// Account session methods
// ---------------------------------------------------------------------------

describe('AccountStore session methods', () => {
  it('startAccountSession + getAccountIdForSession', () => {
    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    store.startAccountSession('sess-lookup', account.accountId);

    assert.equal(store.getAccountIdForSession('sess-lookup'), account.accountId);
  });

  it('endAccountSession makes getAccountIdForSession return undefined', () => {
    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    store.startAccountSession('sess-end', account.accountId);
    store.endAccountSession('sess-end');

    assert.equal(store.getAccountIdForSession('sess-end'), undefined);
  });

  it('getAccountIdForSession returns undefined for unknown session', () => {
    assert.equal(store.getAccountIdForSession('nonexistent'), undefined);
  });
});
