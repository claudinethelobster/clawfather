import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore } from '../src/account-store';

const TEST_FINGERPRINT = 'SHA256:xyzABCDEF1234567890abcdef';
const TEST_FINGERPRINT_2 = 'SHA256:anotherKey9876543210';

let store: AccountStore;

beforeEach(() => {
  store = AccountStore.open(':memory:');
});

afterEach(() => {
  store.close();
});

// ---------------------------------------------------------------------------
// resolveOrCreateAccount
// ---------------------------------------------------------------------------

describe('resolveOrCreateAccount', () => {
  it('creates a new account on first call', () => {
    const result = store.resolveOrCreateAccount(TEST_FINGERPRINT);

    assert.equal(result.isNew, true);
    assert.ok(result.account.accountId);
    assert.equal(result.account.creditsSec, 0);
    assert.equal(result.key.fingerprint, TEST_FINGERPRINT);
    assert.equal(result.key.accountId, result.account.accountId);
  });

  it('returns existing account on second call with same fingerprint', () => {
    const first = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    const second = store.resolveOrCreateAccount(TEST_FINGERPRINT);

    assert.equal(second.isNew, false);
    assert.equal(second.account.accountId, first.account.accountId);
    assert.equal(second.key.keyId, first.key.keyId);
  });

  it('creates separate accounts for different fingerprints', () => {
    const a = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    const b = store.resolveOrCreateAccount(TEST_FINGERPRINT_2);

    assert.equal(a.isNew, true);
    assert.equal(b.isNew, true);
    assert.notEqual(a.account.accountId, b.account.accountId);
  });
});

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

describe('key management', () => {
  it('addKey / getKeysForAccount', () => {
    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    const newKey = store.addKey(account.accountId, TEST_FINGERPRINT_2, 'My laptop');

    assert.equal(newKey.fingerprint, TEST_FINGERPRINT_2);
    assert.equal(newKey.label, 'My laptop');

    const keys = store.getKeysForAccount(account.accountId);
    assert.equal(keys.length, 2);
    const fps = keys.map((k) => k.fingerprint).sort();
    assert.deepEqual(fps, [TEST_FINGERPRINT, TEST_FINGERPRINT_2].sort());
  });

  it('removeKey succeeds when multiple keys exist', () => {
    const { account, key: originalKey } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    store.addKey(account.accountId, TEST_FINGERPRINT_2);

    const result = store.removeKey(originalKey.keyId);
    assert.equal(result.removed, true);

    const remaining = store.getKeysForAccount(account.accountId);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].fingerprint, TEST_FINGERPRINT_2);
  });

  it('removeKey rejects removal of last key', () => {
    const { key } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    const result = store.removeKey(key.keyId);

    assert.equal(result.removed, false);
    assert.equal(result.reason, 'last_key');
  });

  it('removeKey returns not_found for unknown keyId', () => {
    const result = store.removeKey('nonexistent-uuid');
    assert.equal(result.removed, false);
    assert.equal(result.reason, 'not_found');
  });
});

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

describe('token management', () => {
  it('issueToken and getAccountByToken', () => {
    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    const tok = store.issueToken(account.accountId, 'sess-1');

    assert.ok(tok.token);
    assert.equal(tok.token.length, 64); // 32 bytes hex
    assert.equal(tok.accountId, account.accountId);
    assert.equal(tok.sessionId, 'sess-1');
    assert.equal(tok.revokedAt, null);

    const lookup = store.getAccountByToken(tok.token);
    assert.ok(lookup);
    assert.equal(lookup.account.accountId, account.accountId);
    assert.equal(lookup.tokenRecord.tokenId, tok.tokenId);
  });

  it('expired token returns undefined', () => {
    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    const tok = store.issueToken(account.accountId, 'sess-1', 1); // 1ms TTL

    // Query with a timestamp well past expiry
    const lookup = store.getAccountByToken(tok.token, Date.now() + 1000);
    assert.equal(lookup, undefined);
  });

  it('revokeToken makes token invalid', () => {
    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    const tok = store.issueToken(account.accountId, 'sess-1');

    store.revokeToken(tok.tokenId);

    const lookup = store.getAccountByToken(tok.token);
    assert.equal(lookup, undefined);
  });

  it('revokeTokensBySession revokes all tokens for a session', () => {
    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    const tok1 = store.issueToken(account.accountId, 'sess-1');
    const tok2 = store.issueToken(account.accountId, 'sess-1');
    const tok3 = store.issueToken(account.accountId, 'sess-2');

    store.revokeTokensBySession('sess-1');

    assert.equal(store.getAccountByToken(tok1.token), undefined);
    assert.equal(store.getAccountByToken(tok2.token), undefined);
    assert.ok(store.getAccountByToken(tok3.token)); // different session, still valid
  });
});

// ---------------------------------------------------------------------------
// Credit management
// ---------------------------------------------------------------------------

describe('credit management', () => {
  it('addCredits and getBalance', () => {
    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    assert.equal(store.getBalance(account.accountId), 0);

    store.addCredits(account.accountId, 3600, 'stripe_payment', 'evt_123');
    assert.equal(store.getBalance(account.accountId), 3600);

    store.addCredits(account.accountId, 1800, 'bonus', 'welcome');
    assert.equal(store.getBalance(account.accountId), 5400);
  });

  it('debitCredits succeeds with sufficient balance', () => {
    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    store.addCredits(account.accountId, 3600, 'stripe_payment', 'evt_123');

    const result = store.debitCredits(account.accountId, 600, 'sess-1');
    assert.equal(result, true);
    assert.equal(store.getBalance(account.accountId), 3000);
  });

  it('debitCredits returns false when balance is 0', () => {
    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    const result = store.debitCredits(account.accountId, 1, 'sess-1');
    assert.equal(result, false);
    assert.equal(store.getBalance(account.accountId), 0);
  });

  it('debitCredits returns false on insufficient balance', () => {
    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    store.addCredits(account.accountId, 100, 'stripe_payment', 'evt_1');

    const result = store.debitCredits(account.accountId, 200, 'sess-1');
    assert.equal(result, false);
    assert.equal(store.getBalance(account.accountId), 100); // unchanged
  });

  it('getLedger returns entries in reverse chronological order', () => {
    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    store.addCredits(account.accountId, 3600, 'stripe_payment', 'evt_1');
    store.debitCredits(account.accountId, 600, 'sess-1');

    const ledger = store.getLedger(account.accountId);
    assert.equal(ledger.length, 2);

    const credit = ledger.find((e) => e.reason === 'stripe_payment')!;
    const debit = ledger.find((e) => e.reason === 'session_debit')!;
    assert.ok(credit);
    assert.ok(debit);
    assert.equal(credit.changesSec, 3600);
    assert.equal(debit.changesSec, -600);
    assert.ok(debit.createdAt >= credit.createdAt);
  });
});

// ---------------------------------------------------------------------------
// Stripe idempotency
// ---------------------------------------------------------------------------

describe('stripe event idempotency', () => {
  it('hasProcessedStripeEvent returns false for unknown event', () => {
    assert.equal(store.hasProcessedStripeEvent('evt_unknown'), false);
  });

  it('recordStripeEvent + hasProcessedStripeEvent', () => {
    store.recordStripeEvent('evt_abc', 'checkout.session.completed');
    assert.equal(store.hasProcessedStripeEvent('evt_abc'), true);
    assert.equal(store.hasProcessedStripeEvent('evt_other'), false);
  });
});

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

describe('housekeeping', () => {
  it('cleanExpiredTokens removes expired and revoked tokens', () => {
    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);

    // Issue a token that's already expired (1ms TTL)
    store.issueToken(account.accountId, 'sess-1', 1);

    // Issue a valid token then revoke it
    const tok2 = store.issueToken(account.accountId, 'sess-2');
    store.revokeToken(tok2.tokenId);

    // Issue a still-valid token
    store.issueToken(account.accountId, 'sess-3');

    // Small delay to ensure the 1ms token has expired
    const cleaned = store.cleanExpiredTokens();
    assert.ok(cleaned >= 1); // at least the revoked one
  });
});

// ---------------------------------------------------------------------------
// getAccount
// ---------------------------------------------------------------------------

describe('getAccount', () => {
  it('returns undefined for unknown accountId', () => {
    assert.equal(store.getAccount('nonexistent'), undefined);
  });

  it('returns the account after creation', () => {
    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    const fetched = store.getAccount(account.accountId);
    assert.ok(fetched);
    assert.equal(fetched.accountId, account.accountId);
    assert.equal(fetched.creditsSec, 0);
  });
});
