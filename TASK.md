Implement strict SSH session lease semantics per review.

Required code changes:

1) src/ssh-server.ts
- Remove auto-close timer that ends SSH session after 30s.
- Remove any grace-period invalidation logic (60s after close).
- Add immediate teardown function after session creation:
  - endSessionNow(reason)
  - idempotent via local `ended` boolean
  - on end: sessionStore.remove(sessionId), log invalidation reason
  - hook to client.once('close'|'end'|'error')
- Update terminal copy to:
  - Keep this SSH session open while using the web console.
  - Press Ctrl+C to end this session and revoke web access.
- Integrate with web server immediate disconnect helper (below).

2) src/web-server.ts
- Add exported helper:
  - closeSessionClients(sessionId, code=4001, reason='Session expired')
  - closes all ws for that session and deletes map entry.

3) Integrate immediate UI revocation
- In src/ssh-server.ts endSessionNow(), call closeSessionClients(sessionId, 4001, 'SSH session ended').

4) README.md
- Remove all mentions of 60s grace period.
- Clearly state:
  - SSH connection is the authoritative lease.
  - Keep SSH terminal open while using web UI.
  - Ctrl+C / SSH disconnect immediately revokes web session.

5) Optional (skip unless tiny/easy):
- SSH commands url/status/exit in shell loop.
Only do if very low risk. Otherwise skip.

After edits:
- npx tsc --noEmit
- git add -A
- git commit -m "fix: make SSH connection the authoritative session lease"
- git push
