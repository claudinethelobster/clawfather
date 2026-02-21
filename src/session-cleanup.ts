import { execSync } from 'child_process';
import { unlinkSync } from 'fs';
import { query } from './db';
import { sessionStore } from './sessions';
import { closeSessionClients } from './web-server';
import { auditLog } from './audit';

const TMP_DIR = '/tmp/clawdfather';

export function startSessionCleanup(): NodeJS.Timeout {
  const timer = setInterval(async () => {
    try {
      const stale = await query(
        `SELECT sl.id, c.username, c.host, c.port
         FROM session_leases sl
         JOIN ssh_connections c ON c.id = sl.connection_id
         WHERE sl.status = 'active'
           AND sl.last_heartbeat_at < NOW() - INTERVAL '30 minutes'`,
      );

      for (const row of stale.rows) {
        const controlPath = `${TMP_DIR}/${row.id}.sock`;

        try {
          execSync(
            `ssh -S "${controlPath}" -O exit -p ${row.port} ${row.username}@${row.host}`,
            { stdio: 'ignore', timeout: 5000 },
          );
        } catch {}

        try { unlinkSync(controlPath); } catch {}

        sessionStore.remove(row.id);
        closeSessionClients(row.id, 4001, 'Session expired due to inactivity');

        await query(
          `UPDATE session_leases SET status = 'closed', closed_at = NOW(), close_reason = 'timeout' WHERE id = $1`,
          [row.id],
        );

        auditLog({
          action: 'session.timeout',
          target_type: 'session_lease',
          target_id: row.id,
          result: 'ok',
        });
      }
    } catch (err) {
      console.error('[clawdfather] Session cleanup error:', (err as Error).message);
    }
  }, 60_000);

  timer.unref();
  return timer;
}
