import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type {
  Account,
  AccountKey,
  AccountToken,
  LedgerEntry,
  StripeEventRecord,
} from './types';

const DEFAULT_SCOPE = 'account:read account:keys:manage payment:initiate';
const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

const MIGRATION_V1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  credits_sec INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS account_keys (
  key_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_tokens (
  token_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  scope TEXT NOT NULL DEFAULT '${DEFAULT_SCOPE}'
);

CREATE INDEX IF NOT EXISTS idx_account_tokens_token ON account_tokens(token);
CREATE INDEX IF NOT EXISTS idx_account_tokens_session ON account_tokens(session_id);

CREATE TABLE IF NOT EXISTS credit_ledger (
  ledger_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  changes_sec INTEGER NOT NULL,
  reason TEXT NOT NULL,
  reference_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stripe_events (
  stripe_event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_sessions (
  session_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  last_debit_at INTEGER NOT NULL,
  ended_at INTEGER
);
`;

interface StmtCache {
  insertAccount: Database.Statement;
  insertKey: Database.Statement;
  findKeyByFingerprint: Database.Statement;
  getAccount: Database.Statement;
  getKeysForAccount: Database.Statement;
  countKeysForAccount: Database.Statement;
  removeKey: Database.Statement;
  getKeyById: Database.Statement;
  insertToken: Database.Statement;
  findValidToken: Database.Statement;
  revokeToken: Database.Statement;
  revokeTokensBySession: Database.Statement;
  updateCredits: Database.Statement;
  getBalance: Database.Statement;
  insertLedger: Database.Statement;
  getLedger: Database.Statement;
  findStripeEvent: Database.Statement;
  insertStripeEvent: Database.Statement;
  cleanExpiredTokens: Database.Statement;
  updateAccountTimestamp: Database.Statement;
}

export class AccountStore {
  private db: Database.Database;
  private stmts: StmtCache;

  private constructor(db: Database.Database) {
    this.db = db;
    this.stmts = this.prepareStatements();
  }

  static open(dbPath: string): AccountStore {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    AccountStore.applyMigrations(db);

    return new AccountStore(db);
  }

  private static applyMigrations(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);

    const currentVersion = db
      .prepare('SELECT MAX(version) AS v FROM schema_migrations')
      .get() as { v: number | null };

    if ((currentVersion?.v ?? 0) < 1) {
      db.exec(MIGRATION_V1);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        1,
        Date.now(),
      );
    }
  }

  private prepareStatements(): StmtCache {
    return {
      insertAccount: this.db.prepare(
        'INSERT INTO accounts (account_id, created_at, updated_at, credits_sec) VALUES (?, ?, ?, 0)',
      ),
      insertKey: this.db.prepare(
        'INSERT INTO account_keys (key_id, account_id, fingerprint, label, added_at) VALUES (?, ?, ?, ?, ?)',
      ),
      findKeyByFingerprint: this.db.prepare(
        'SELECT key_id, account_id, fingerprint, label, added_at FROM account_keys WHERE fingerprint = ?',
      ),
      getAccount: this.db.prepare(
        'SELECT account_id, created_at, updated_at, credits_sec FROM accounts WHERE account_id = ?',
      ),
      getKeysForAccount: this.db.prepare(
        'SELECT key_id, account_id, fingerprint, label, added_at FROM account_keys WHERE account_id = ? ORDER BY added_at',
      ),
      countKeysForAccount: this.db.prepare(
        'SELECT COUNT(*) AS cnt FROM account_keys WHERE account_id = ?',
      ),
      removeKey: this.db.prepare('DELETE FROM account_keys WHERE key_id = ?'),
      getKeyById: this.db.prepare(
        'SELECT key_id, account_id, fingerprint, label, added_at FROM account_keys WHERE key_id = ?',
      ),
      insertToken: this.db.prepare(
        'INSERT INTO account_tokens (token_id, account_id, session_id, token, issued_at, expires_at, revoked_at, scope) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
      ),
      findValidToken: this.db.prepare(
        'SELECT t.token_id, t.account_id, t.session_id, t.token, t.issued_at, t.expires_at, t.revoked_at, t.scope, a.account_id AS a_account_id, a.created_at AS a_created_at, a.updated_at AS a_updated_at, a.credits_sec AS a_credits_sec FROM account_tokens t JOIN accounts a ON t.account_id = a.account_id WHERE t.token = ? AND t.revoked_at IS NULL AND t.expires_at > ?',
      ),
      revokeToken: this.db.prepare(
        'UPDATE account_tokens SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL',
      ),
      revokeTokensBySession: this.db.prepare(
        'UPDATE account_tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL',
      ),
      updateCredits: this.db.prepare(
        'UPDATE accounts SET credits_sec = credits_sec + ?, updated_at = ? WHERE account_id = ?',
      ),
      getBalance: this.db.prepare(
        'SELECT credits_sec FROM accounts WHERE account_id = ?',
      ),
      insertLedger: this.db.prepare(
        'INSERT INTO credit_ledger (ledger_id, account_id, changes_sec, reason, reference_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      getLedger: this.db.prepare(
        'SELECT ledger_id, account_id, changes_sec, reason, reference_id, created_at FROM credit_ledger WHERE account_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      ),
      findStripeEvent: this.db.prepare(
        'SELECT stripe_event_id FROM stripe_events WHERE stripe_event_id = ?',
      ),
      insertStripeEvent: this.db.prepare(
        'INSERT OR IGNORE INTO stripe_events (stripe_event_id, type, processed_at) VALUES (?, ?, ?)',
      ),
      cleanExpiredTokens: this.db.prepare(
        'DELETE FROM account_tokens WHERE expires_at <= ? OR revoked_at IS NOT NULL',
      ),
      updateAccountTimestamp: this.db.prepare(
        'UPDATE accounts SET updated_at = ? WHERE account_id = ?',
      ),
    };
  }

  // ---------------------------------------------------------------------------
  // Account lifecycle
  // ---------------------------------------------------------------------------

  resolveOrCreateAccount(fingerprint: string): {
    account: Account;
    key: AccountKey;
    isNew: boolean;
  } {
    const existing = this.stmts.findKeyByFingerprint.get(fingerprint) as
      | { key_id: string; account_id: string; fingerprint: string; label: string; added_at: number }
      | undefined;

    if (existing) {
      const account = this.getAccount(existing.account_id)!;
      return {
        account,
        key: rowToAccountKey(existing),
        isNew: false,
      };
    }

    const now = Date.now();
    const accountId = uuidv4();
    const keyId = uuidv4();
    const label = fingerprint.length > 20 ? fingerprint.slice(0, 20) + '...' : fingerprint;

    const createTx = this.db.transaction(() => {
      this.stmts.insertAccount.run(accountId, now, now);
      this.stmts.insertKey.run(keyId, accountId, fingerprint, label, now);
    });
    createTx();

    const account: Account = {
      accountId,
      createdAt: now,
      updatedAt: now,
      creditsSec: 0,
    };
    const key: AccountKey = {
      keyId,
      accountId,
      fingerprint,
      label,
      addedAt: now,
    };

    return { account, key, isNew: true };
  }

  getAccount(accountId: string): Account | undefined {
    const row = this.stmts.getAccount.get(accountId) as
      | { account_id: string; created_at: number; updated_at: number; credits_sec: number }
      | undefined;
    if (!row) return undefined;
    return {
      accountId: row.account_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      creditsSec: row.credits_sec,
    };
  }

  getAccountByToken(
    token: string,
    now?: number,
  ): { account: Account; tokenRecord: AccountToken } | undefined {
    const ts = now ?? Date.now();
    const row = this.stmts.findValidToken.get(token, ts) as
      | {
          token_id: string;
          account_id: string;
          session_id: string;
          token: string;
          issued_at: number;
          expires_at: number;
          revoked_at: number | null;
          scope: string;
          a_account_id: string;
          a_created_at: number;
          a_updated_at: number;
          a_credits_sec: number;
        }
      | undefined;
    if (!row) return undefined;

    return {
      account: {
        accountId: row.a_account_id,
        createdAt: row.a_created_at,
        updatedAt: row.a_updated_at,
        creditsSec: row.a_credits_sec,
      },
      tokenRecord: {
        tokenId: row.token_id,
        accountId: row.account_id,
        sessionId: row.session_id,
        token: row.token,
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        scope: row.scope,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Key management
  // ---------------------------------------------------------------------------

  getKeysForAccount(accountId: string): AccountKey[] {
    const rows = this.stmts.getKeysForAccount.all(accountId) as Array<{
      key_id: string;
      account_id: string;
      fingerprint: string;
      label: string;
      added_at: number;
    }>;
    return rows.map(rowToAccountKey);
  }

  addKey(accountId: string, fingerprint: string, label?: string): AccountKey {
    const keyId = uuidv4();
    const now = Date.now();
    const keyLabel =
      label ?? (fingerprint.length > 20 ? fingerprint.slice(0, 20) + '...' : fingerprint);

    this.stmts.insertKey.run(keyId, accountId, fingerprint, keyLabel, now);
    this.stmts.updateAccountTimestamp.run(now, accountId);

    return {
      keyId,
      accountId,
      fingerprint,
      label: keyLabel,
      addedAt: now,
    };
  }

  removeKey(keyId: string): { removed: boolean; reason?: string } {
    const key = this.stmts.getKeyById.get(keyId) as
      | { key_id: string; account_id: string; fingerprint: string; label: string; added_at: number }
      | undefined;

    if (!key) {
      return { removed: false, reason: 'not_found' };
    }

    const countRow = this.stmts.countKeysForAccount.get(key.account_id) as { cnt: number };
    if (countRow.cnt <= 1) {
      return { removed: false, reason: 'last_key' };
    }

    this.stmts.removeKey.run(keyId);
    this.stmts.updateAccountTimestamp.run(Date.now(), key.account_id);
    return { removed: true };
  }

  // ---------------------------------------------------------------------------
  // Token management
  // ---------------------------------------------------------------------------

  issueToken(accountId: string, sessionId: string, ttlMs?: number): AccountToken {
    const tokenId = uuidv4();
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + (ttlMs ?? DEFAULT_TOKEN_TTL_MS);

    this.stmts.insertToken.run(tokenId, accountId, sessionId, token, now, expiresAt, DEFAULT_SCOPE);

    return {
      tokenId,
      accountId,
      sessionId,
      token,
      issuedAt: now,
      expiresAt,
      revokedAt: null,
      scope: DEFAULT_SCOPE,
    };
  }

  revokeToken(tokenId: string): void {
    this.stmts.revokeToken.run(Date.now(), tokenId);
  }

  revokeTokensBySession(sessionId: string): void {
    this.stmts.revokeTokensBySession.run(Date.now(), sessionId);
  }

  // ---------------------------------------------------------------------------
  // Credit management
  // ---------------------------------------------------------------------------

  getBalance(accountId: string): number {
    const row = this.stmts.getBalance.get(accountId) as { credits_sec: number } | undefined;
    return row?.credits_sec ?? 0;
  }

  addCredits(
    accountId: string,
    seconds: number,
    reason: LedgerEntry['reason'],
    referenceId: string,
  ): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.stmts.updateCredits.run(seconds, now, accountId);
      this.stmts.insertLedger.run(uuidv4(), accountId, seconds, reason, referenceId, now);
    });
    tx();
  }

  debitCredits(accountId: string, seconds: number, sessionId: string): boolean {
    const tx = this.db.transaction(() => {
      const row = this.stmts.getBalance.get(accountId) as { credits_sec: number } | undefined;
      const balance = row?.credits_sec ?? 0;
      if (balance < seconds) return false;

      const now = Date.now();
      this.stmts.updateCredits.run(-seconds, now, accountId);
      this.stmts.insertLedger.run(uuidv4(), accountId, -seconds, 'session_debit', sessionId, now);
      return true;
    });
    return tx() as boolean;
  }

  getLedger(accountId: string, limit?: number): LedgerEntry[] {
    const rows = this.stmts.getLedger.all(accountId, limit ?? 100) as Array<{
      ledger_id: string;
      account_id: string;
      changes_sec: number;
      reason: LedgerEntry['reason'];
      reference_id: string;
      created_at: number;
    }>;
    return rows.map((r) => ({
      ledgerId: r.ledger_id,
      accountId: r.account_id,
      changesSec: r.changes_sec,
      reason: r.reason,
      referenceId: r.reference_id,
      createdAt: r.created_at,
    }));
  }

  // ---------------------------------------------------------------------------
  // Stripe idempotency
  // ---------------------------------------------------------------------------

  hasProcessedStripeEvent(eventId: string): boolean {
    const row = this.stmts.findStripeEvent.get(eventId);
    return row !== undefined;
  }

  recordStripeEvent(eventId: string, type: string): void {
    this.stmts.insertStripeEvent.run(eventId, type, Date.now());
  }

  // ---------------------------------------------------------------------------
  // Housekeeping
  // ---------------------------------------------------------------------------

  cleanExpiredTokens(): number {
    const result = this.stmts.cleanExpiredTokens.run(Date.now());
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToAccountKey(row: {
  key_id: string;
  account_id: string;
  fingerprint: string;
  label: string;
  added_at: number;
}): AccountKey {
  return {
    keyId: row.key_id,
    accountId: row.account_id,
    fingerprint: row.fingerprint,
    label: row.label,
    addedAt: row.added_at,
  };
}
