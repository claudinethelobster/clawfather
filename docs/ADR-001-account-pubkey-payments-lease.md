# ADR-001: Pubkey-Based Accounts + Payment-Gated Session Leasing

**Status:** Accepted  
**Date:** 2026-02-19  
**Branch:** `feat/account-pubkey-payments-lease`

---

## Context

Clawdfather currently:
- Accepts any SSH public key (no persistent identity)
- Creates ephemeral, in-memory sessions (lost on restart)
- Provides no payment gate or credit system

We want to move to a **terminal.shop-style identity model**: each SSH public key fingerprint is the primary identity token. From that identity, we build accounts, track time credits, and issue scoped web-UI tokens.

---

## Decisions

### 1. Account Model

**Keyed by SHA-256 pubkey fingerprint** (`SHA256:<base64>` format, as produced by OpenSSH).

```
Account {
  accountId:   UUID (primary key)
  createdAt:   ISO timestamp
  updatedAt:   ISO timestamp
  creditsSec:  integer (seconds of leased time remaining)
}

AccountKey {
  keyId:         UUID (primary key)
  accountId:     FK → Account
  fingerprint:   text UNIQUE (SSH SHA-256 fingerprint)
  label:         text (optional human label)
  addedAt:       ISO timestamp
}
```

**Resolution flow:**  
`SSH publickey auth → fingerprint → AccountKey lookup → Account`

**First-seen auto-registration:** If fingerprint is unknown, auto-create an Account + AccountKey. This matches the friction-free terminal.shop pattern.

**Key removal safety:** Cannot remove the last key associated with an account unless the account has zero active sessions and no credits (or user explicitly confirms and accepts account will become inaccessible).

### 2. Session Lease Token Model

When an SSH connection completes setup, we issue a **scoped account token** that enables the web UI to authenticate as the account (not just as a session).

```
AccountToken {
  tokenId:      UUID (primary key)
  accountId:    FK → Account
  sessionId:    UUID (the originating SSH session, for correlation)
  token:        text (cryptographically random, 32 bytes, hex-encoded)
  issuedAt:     integer (unix ms)
  expiresAt:    integer (unix ms) — short-lived: 15 minutes by default
  revokedAt:    integer | null
  scope:        text ('account:read account:keys:manage payment:initiate')
}
```

**Token properties:**
- Opaque bearer token (not JWT, no client-side decodable payload)
- Short TTL (15 min), rotated on each SSH session
- Bound to accountId only (not to a specific target host)
- Stored server-side; every request validates against DB
- Revoked immediately when the originating SSH session ends
- Not over-privileged: cannot execute SSH commands; only account management + payment initiation

### 3. Payment Ledger Model

Prepaid time credits at $1/hour = $0.000278/second.

```
CreditLedger {
  ledgerId:     UUID
  accountId:    FK → Account
  changesSec:   integer  (positive = credit, negative = debit)
  reason:       text     ('stripe_payment' | 'session_debit' | 'refund' | 'bonus')
  referenceId:  text     (Stripe payment_intent ID or session ID)
  createdAt:    integer  (unix ms)
}

StripeEvent {
  stripeEventId:  text (Stripe event ID, PRIMARY KEY for idempotency)
  type:           text
  processedAt:    integer (unix ms)
}
```

**Debit rate:** 1 second of credit consumed per second of active leased session.  
**Enforcement:** Background ticker debits active sessions every 30 seconds; when balance ≤ 0, session is forcibly ended and web client receives a clear credit-exhaustion message.

### 4. Stripe Integration Boundaries

```
Client (web UI)
  → POST /api/account/checkout   (authenticated with account token)
  → returns { checkoutUrl }
  → redirect to Stripe checkout

Stripe checkout completes
  → POST /api/webhooks/stripe   (raw body, Stripe-Signature header)
  → verify signature with STRIPE_WEBHOOK_SECRET
  → idempotency check: upsert StripeEvent by event.id
  → on checkout.session.completed: add credits to account
  → respond 200 immediately (async processing)
```

**Price:** Configured as `STRIPE_PRICE_ID` env var. Initial: $1/hour price point, configurable hours per purchase.

### 5. Storage Engine

**SQLite via `better-sqlite3`** (synchronous API, zero network, battle-tested, WAL mode).

Location: configurable via `config.dbPath`, defaults to `<plugin_root>/data/clawdfather.db`.

Schema migrations applied on startup via embedded migration runner (no external migration tool required).

### 6. SSH Flow Changes

Before:
```
SSH auth → fingerprint captured (local var) → user types target → session created → URL shown
```

After:
```
SSH auth → fingerprint → resolve/create Account → check credits → if no credits: show purchase URL → if has credits: user types target → ControlMaster → session created → account token issued → URL shown with token → credits start debiting
```

Web UI changes:
- `/#session=<sessionId>&token=<accountToken>` — token authenticates account management
- Or `/#account=<accountToken>` — direct account view (no SSH session required for management)

### 7. Threat Model + Abuse Controls

| Threat | Control |
|--------|---------|
| Key spoofing / impersonation | SSH protocol guarantees: only holder of private key authenticates. Fingerprint computed server-side from presented key. |
| Token theft | Short TTL (15 min), HTTPS only, revoked on SSH close. No JWT so no offline forgery. |
| Replay attacks on tokens | DB lookup; revoked tokens rejected immediately. |
| Webhook replay/forgery | `stripe.webhooks.constructEvent` signature verification + idempotency table. |
| Credit exhaustion bypass | Server-side enforcement; session terminated at ≤0 credits. |
| Key removal locking account | Safety check: reject last-key removal if account has credits > 0 or active sessions. |
| SQL injection | Parameterized queries only (better-sqlite3 prepared statements). |
| Path traversal (web server) | Already guarded; account API endpoints added under /api/account/ with token auth. |
| DoS via account creation | SSH server is the gateway; SSH brute-force protection is the outer layer. |
| Concurrent credit debit race | SQLite WAL + atomic `UPDATE creditsSec WHERE creditsSec > 0`. |

---

## File Structure (New)

```
src/
  account-store.ts     — SQLite DB init, Account/AccountKey/Token/Ledger CRUD
  credit-manager.ts    — Debit loop, balance checks, session enforcement
  stripe-payments.ts   — Stripe checkout + webhook handler
  types.ts             — Extended with Account, AccountToken, etc.
  ssh-server.ts        — Modified: resolve account, issue token, credit gate
  web-server.ts        — Extended: /api/account/*, /api/webhooks/stripe
  sessions.ts          — No change needed (session lifetime still SSH-bound)
  
ui/
  account.html         — Account management SPA (keys, balance, purchase CTA)
  account.js           — Account UI logic
  (index.html unchanged, links to account page for management)

docs/
  ADR-001-account-pubkey-payments-lease.md  (this file)

tests/
  account-store.test.ts
  credit-manager.test.ts
  stripe-payments.test.ts
  token-auth.test.ts
```

---

## Known Limitations / Follow-ups

- **No email/username**: Identity is purely key-based. Users lose access if they lose their private key and have no other keys registered.
- **No admin panel**: No way to inspect/modify accounts without direct DB access.
- **Single-node storage**: SQLite means single-process only; distributed deployment would need Postgres.
- **Stripe only**: No other payment providers. Could add in future.
- **Credit exhaustion is hard-stop**: Could implement grace period or notification-then-stop UX.
- **Key label UX**: SSH terminal UX for adding key labels is minimal.
