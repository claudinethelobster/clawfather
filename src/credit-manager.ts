import { AccountStore } from './account-store';
import { sessionStore } from './sessions';
import { closeSessionClients } from './web-server';

export class CreditManager {
  private timer: NodeJS.Timeout | null = null;
  private intervalMs: number;

  constructor(
    private store: AccountStore,
    intervalMs: number = 30_000,
  ) {
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for testing — run a single debit cycle. */
  tick(): void {
    this.cleanStaleSessions();

    const sessions = sessionStore.list();
    const debitSec = Math.round(this.intervalMs / 1000);

    for (const session of sessions) {
      const accountId = this.store.getAccountIdForSession(session.sessionId);
      if (!accountId) continue;

      const ok = this.store.debitCredits(accountId, debitSec, session.sessionId);

      if (!ok) {
        sessionStore.remove(session.sessionId);
        closeSessionClients(
          session.sessionId,
          4010,
          'Credits exhausted. Please purchase more time.',
        );
        this.store.endAccountSession(session.sessionId);
        console.log(
          `[clawdfather] Session ${session.sessionId} ended — credits exhausted for account ${accountId}`,
        );
      } else {
        this.store.recordSessionDebitTick(session.sessionId);
      }
    }
  }

  /**
   * Find account_sessions marked active in the DB but missing from the
   * in-memory sessionStore (SSH connection died without cleanup). Mark them
   * ended and revoke their tokens.
   */
  cleanStaleSessions(): number {
    const dbSessions = this.store.getActiveAccountSessions();
    let cleaned = 0;

    for (const { sessionId } of dbSessions) {
      if (sessionStore.get(sessionId)) continue;

      this.store.endAccountSession(sessionId);
      this.store.revokeTokensBySession(sessionId);
      closeSessionClients(sessionId, 4001, 'Stale session cleaned up');
      cleaned++;
      console.log(`[clawdfather] Cleaned stale session ${sessionId}`);
    }

    return cleaned;
  }
}
