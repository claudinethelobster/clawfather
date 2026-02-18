import { Session } from './types';
import { spawn } from 'child_process';
import { unlink } from 'fs/promises';

/**
 * In-memory session store for active SSH sessions.
 * Handles creation, lookup, activity tracking, and expiry cleanup.
 */
class SessionStore {
  private sessions: Map<string, Session> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private timeoutMs: number = 1800000; // 30 minutes default

  /** Start the periodic cleanup timer */
  start(timeoutMs: number): void {
    this.timeoutMs = timeoutMs;
    // Run cleanup every 60 seconds
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref(); // Don't keep process alive just for cleanup
  }

  /** Stop the cleanup timer */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** Register a new session */
  create(session: Session): void {
    this.sessions.set(session.sessionId, session);
  }

  /** Get a session by ID, returns undefined if not found or expired */
  get(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    // Check if expired
    if (Date.now() - session.lastActivity > this.timeoutMs) {
      this.sessions.delete(sessionId);
      return undefined;
    }

    return session;
  }

  /** Touch a session to update its last activity timestamp */
  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
    }
  }

  /** Remove a session, cleaning up its ControlMaster */
  remove(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.cleanupControlMaster(session);
    }
    return this.sessions.delete(sessionId);
  }

  /** Get all active sessions */
  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  /** Clean up a ControlMaster socket for a session */
  private cleanupControlMaster(session: Session): void {
    const { targetUser, targetHost, controlPath, sessionId } = session;
    console.log(`[clawdfather] Cleaning up ControlMaster for session ${sessionId} (${targetUser}@${targetHost})`);

    // Send exit command to ControlMaster
    const proc = spawn('ssh', ['-S', controlPath, '-O', 'exit', `${targetUser}@${targetHost}`], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    proc.on('error', (err: Error) => {
      console.log(`[clawdfather] ControlMaster exit command failed for ${sessionId}: ${err.message}`);
    });

    // Also try to remove the socket file
    unlink(controlPath).catch(() => {
      // Socket may already be gone — that's fine
    });
  }

  /** Remove expired sessions */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > this.timeoutMs) {
        this.cleanupControlMaster(session);
        this.sessions.delete(id);
        console.log(`[clawdfather] Session ${id} expired (${session.targetUser}@${session.targetHost})`);
      }
    }
  }
}

/** Singleton session store instance */
export const sessionStore = new SessionStore();
