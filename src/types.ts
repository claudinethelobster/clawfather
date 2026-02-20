/** Metadata for an active SSH session */
export interface Session {
  /** Unique session identifier */
  sessionId: string;
  /** SSH public key fingerprint of the user */
  keyFingerprint: string;
  /** Target SSH hostname or IP */
  targetHost: string;
  /** Target SSH username */
  targetUser: string;
  /** Target SSH port */
  targetPort: number;
  /** Path to the SSH ControlMaster socket */
  controlPath: string;
  /** Timestamp when session was established */
  connectedAt: number;
  /** Timestamp of last activity */
  lastActivity: number;
}

/** Result of executing a command over SSH */
export interface ExecResult {
  /** Exit code of the command */
  exitCode: number;
  /** Combined stdout output */
  stdout: string;
  /** Combined stderr output */
  stderr: string;
  /** Whether the command timed out */
  timedOut: boolean;
}

/** Plugin configuration from openclaw.plugin.json */
export interface ClawdfatherConfig {
  sshPort: number;
  webPort: number;
  webDomain: string;
  sessionTimeoutMs: number;
  hostKeyPath?: string;
  /** Allowed CORS origins. Empty/undefined = same-origin only. ["*"] = permissive. */
  allowedOrigins?: string[];
  /** Path to SQLite database file */
  dbPath?: string;
  /** Session token TTL in milliseconds (default 900000 = 15 min) */
  tokenTtlMs?: number;
  /** Credit rate in cents per hour (default 100 = $1/hour) */
  creditRatePerHourCents?: number;
  /** Stripe secret key for payment processing */
  stripeSecretKey?: string;
  /** Stripe webhook signing secret */
  stripeWebhookSecret?: string;
  /** Stripe Price ID for credit purchases */
  stripePriceId?: string;
}

/** A persistent user account identified by one or more SSH pubkeys */
export interface Account {
  accountId: string;
  createdAt: number;
  updatedAt: number;
  /** Seconds of time credit remaining (integer) */
  creditsSec: number;
}

/** Association between an account and a specific SSH public key */
export interface AccountKey {
  keyId: string;
  accountId: string;
  /** SSH SHA256 fingerprint e.g. "SHA256:abc..." */
  fingerprint: string;
  /** Human-readable label (defaults to fingerprint short form) */
  label: string;
  addedAt: number;
}

/** Short-lived scoped account token for web UI authentication */
export interface AccountToken {
  tokenId: string;
  accountId: string;
  /** Originating SSH sessionId */
  sessionId: string;
  /** 32-byte hex-encoded opaque token */
  token: string;
  issuedAt: number;
  /** Unix ms (15 minutes from issuedAt by default) */
  expiresAt: number;
  revokedAt: number | null;
  /** Space-separated permission scopes */
  scope: string;
}

/** A credit ledger entry */
export interface LedgerEntry {
  ledgerId: string;
  accountId: string;
  /** Positive = credit, negative = debit */
  changesSec: number;
  reason: 'stripe_payment' | 'session_debit' | 'refund' | 'bonus' | 'adjustment';
  /** Stripe event ID or session ID */
  referenceId: string;
  createdAt: number;
}

/** Stripe event idempotency record */
export interface StripeEventRecord {
  stripeEventId: string;
  type: string;
  processedAt: number;
}
