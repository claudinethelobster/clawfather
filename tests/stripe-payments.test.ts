import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { AccountStore } from '../src/account-store';
import { StripePayments } from '../src/stripe-payments';
import type { ClawdfatherConfig } from '../src/types';

const TEST_FINGERPRINT = 'SHA256:stripeTestKey123abc';
const WEBHOOK_SECRET = 'whsec_test_secret';

function makeConfig(overrides?: Partial<ClawdfatherConfig>): ClawdfatherConfig {
  return {
    sshPort: 22,
    webPort: 3000,
    webDomain: 'localhost',
    sessionTimeoutMs: 1_800_000,
    stripeSecretKey: 'sk_test_fake_key_for_unit_tests',
    stripeWebhookSecret: WEBHOOK_SECRET,
    ...overrides,
  };
}

function makePayload(eventId: string, accountId: string, creditSeconds: number): string {
  return JSON.stringify({
    id: eventId,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_123',
        object: 'checkout.session',
        metadata: {
          accountId,
          creditSeconds: String(creditSeconds),
          hours: String(creditSeconds / 3600),
        },
      },
    },
  });
}

let store: AccountStore;

beforeEach(() => {
  store = AccountStore.open(':memory:');
});

afterEach(() => {
  store.close();
});

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('StripePayments constructor', () => {
  it('throws if no secret key configured', () => {
    const origEnv = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      assert.throws(
        () => new StripePayments(store, makeConfig({ stripeSecretKey: undefined })),
        /Stripe secret key not configured/,
      );
    } finally {
      if (origEnv !== undefined) process.env.STRIPE_SECRET_KEY = origEnv;
    }
  });

  it('constructs successfully with a secret key', () => {
    const payments = new StripePayments(store, makeConfig());
    assert.ok(payments);
  });
});

// ---------------------------------------------------------------------------
// handleWebhook — signature verification
// ---------------------------------------------------------------------------

describe('handleWebhook', () => {
  it('throws on invalid signature', async () => {
    const payments = new StripePayments(store, makeConfig());
    const rawBody = Buffer.from('{"id":"evt_bad"}');

    await assert.rejects(
      () => payments.handleWebhook(rawBody, 'bad_signature'),
      /Webhook signature verification failed/,
    );
  });

  it('throws when webhook secret is not configured', async () => {
    const payments = new StripePayments(
      store,
      makeConfig({ stripeWebhookSecret: undefined }),
    );

    const origEnv = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;

    try {
      await assert.rejects(
        () => payments.handleWebhook(Buffer.from('{}'), 'sig'),
        /Stripe webhook secret not configured/,
      );
    } finally {
      if (origEnv !== undefined) process.env.STRIPE_WEBHOOK_SECRET = origEnv;
    }
  });

  it('processes a valid webhook and adds credits', async () => {
    const config = makeConfig();
    const payments = new StripePayments(store, config);

    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);
    assert.equal(store.getBalance(account.accountId), 0);

    const payload = makePayload('evt_test_001', account.accountId, 3600);
    const stripeLib = new Stripe('sk_test_fake_key_for_unit_tests', {
      apiVersion: '2025-01-27.acacia' as any,
    });
    const header = stripeLib.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });

    const result = await payments.handleWebhook(Buffer.from(payload), header);

    assert.equal(result.processed, true);
    assert.equal(result.eventType, 'checkout.session.completed');
    assert.equal(store.getBalance(account.accountId), 3600);
  });

  it('idempotency: second call with same event ID returns processed=false', async () => {
    const config = makeConfig();
    const payments = new StripePayments(store, config);

    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);

    const payload = makePayload('evt_test_idem', account.accountId, 7200);
    const stripeLib = new Stripe('sk_test_fake_key_for_unit_tests', {
      apiVersion: '2025-01-27.acacia' as any,
    });
    const header = stripeLib.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });

    const first = await payments.handleWebhook(Buffer.from(payload), header);
    assert.equal(first.processed, true);
    assert.equal(store.getBalance(account.accountId), 7200);

    // Generate a fresh header (new timestamp) for the replayed event
    const header2 = stripeLib.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });

    const second = await payments.handleWebhook(Buffer.from(payload), header2);
    assert.equal(second.processed, false);
    assert.equal(store.getBalance(account.accountId), 7200); // unchanged
  });

  it('handles non-checkout event types without crediting', async () => {
    const config = makeConfig();
    const payments = new StripePayments(store, config);

    const payload = JSON.stringify({
      id: 'evt_test_other',
      object: 'event',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_123' } },
    });

    const stripeLib = new Stripe('sk_test_fake_key_for_unit_tests', {
      apiVersion: '2025-01-27.acacia' as any,
    });
    const header = stripeLib.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });

    const result = await payments.handleWebhook(Buffer.from(payload), header);
    assert.equal(result.processed, true);
    assert.equal(result.eventType, 'payment_intent.succeeded');
    assert.equal(store.hasProcessedStripeEvent('evt_test_other'), true);
  });
});

// ---------------------------------------------------------------------------
// createCheckoutSession — skip if no real Stripe key
// ---------------------------------------------------------------------------

const hasRealStripeKey = !!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_');

describe('createCheckoutSession', { skip: !hasRealStripeKey ? 'No STRIPE_SECRET_KEY set' : false }, () => {
  it('creates a checkout session URL', async () => {
    const config = makeConfig({
      stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    });
    const payments = new StripePayments(store, config);
    const { account } = store.resolveOrCreateAccount(TEST_FINGERPRINT);

    const result = await payments.createCheckoutSession({
      accountId: account.accountId,
      hours: 1,
      successUrl: 'http://localhost:3000/?payment=success',
      cancelUrl: 'http://localhost:3000/?payment=cancelled',
    });

    assert.ok(result.url);
    assert.ok(result.url.startsWith('https://checkout.stripe.com'));
    assert.ok(result.sessionId);
  });
});
