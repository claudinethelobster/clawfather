Fix SSH agent forwarding bridge. Currently the spawned outbound `ssh` process has no access to the client's forwarded SSH agent.

## The Problem
When user does `ssh -A clawdfather.ai`, the ssh2 library accepts the connection but doesn't automatically make the forwarded agent available as a Unix socket. The spawned `ssh` command in `establishControlMaster()` needs `SSH_AUTH_SOCK` to point to the client's agent.

## The Fix
In `src/ssh-server.ts`:

### 1) Accept agent forwarding on the session
The session handler already may have `session.on('auth-agent')` or similar. Make sure we accept it:
```ts
session.on('auth-agent', (accept) => { accept(); });
```

### 2) Create an agent proxy Unix socket per connection
Before calling `establishControlMaster`, create a local Unix domain socket that bridges to the client's forwarded agent:

```ts
import { createServer as createNetServer, Server as NetServer } from 'net';
import { unlinkSync } from 'fs';

const agentSocketPath = `/tmp/clawdfather-agent-${sessionId}`;

const agentServer = createNetServer((localSocket) => {
  // Open an auth-agent channel back to the client's agent
  (client as any).openssh_agentForward((err: Error | undefined, agentStream: any) => {
    if (err) {
      localSocket.destroy();
      return;
    }
    localSocket.pipe(agentStream);
    agentStream.pipe(localSocket);
    localSocket.on('close', () => agentStream.destroy());
    agentStream.on('close', () => localSocket.destroy());
  });
});

agentServer.listen(agentSocketPath);
```

Note: The ssh2 API for opening an agent channel from server side may be:
- `client.openssh_agentForward(callback)` — check ssh2 docs
- Or `(client as any).openChannel('auth-agent@openssh.com', callback)` 

Read the ssh2 TypeScript types or source to find the correct method. The goal is to open a channel of type `auth-agent@openssh.com` back to the client.

### 3) Pass SSH_AUTH_SOCK to the spawned ssh process
In `establishControlMaster()`, accept an optional `agentSocketPath` parameter and set it in the env:

```ts
const proc = spawn('ssh', args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, SSH_AUTH_SOCK: agentSocketPath },
});
```

### 4) Clean up the agent socket
In `endSessionNow()`, clean up the agent socket:
```ts
agentServer.close();
try { unlinkSync(agentSocketPath); } catch {}
```

### 5) Pass agentSocketPath through the call chain
`handleInput` creates the sessionId and agentSocketPath, passes it to `establishControlMaster`.

## Important notes
- Check the ssh2 npm package docs/types for the correct API to open an agent channel from the server side
- The `auth-agent` event on session MUST be accepted for forwarding to work
- The agent proxy socket must be created BEFORE calling establishControlMaster
- Clean up sockets on session end

## After:
```bash
npx tsc --noEmit
git add -A  
git commit -m "fix: bridge SSH agent forwarding to spawned ControlMaster process"
git push
```
