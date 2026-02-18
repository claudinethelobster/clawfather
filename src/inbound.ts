import { getClawdfatherRuntime } from "./runtime";
import { sendToSession } from "./web-server";
import { sessionStore } from "./sessions";

const CHANNEL_ID = "clawdfather" as const;

/**
 * Enrich a bootstrap system message with server-side SSH context
 * (controlPath is never sent to the browser).
 */
function enrichWithSSHContext(text: string, sessionId: string): string {
  if (!text.startsWith("[System: Clawdfather session active")) return text;

  const session = sessionStore.get(sessionId);
  if (!session) return text;

  const { controlPath, targetUser, targetHost, targetPort } = session;
  const portFlag = targetPort !== 22 ? ` -p ${targetPort}` : "";
  const scpPortFlag = targetPort !== 22 ? ` -P ${targetPort}` : "";
  const sshPrefix = `ssh -o ControlPath=${controlPath} -o ControlMaster=no -o BatchMode=yes${portFlag} ${targetUser}@${targetHost}`;
  const scpPrefix = `scp -o ControlPath=${controlPath} -o ControlMaster=no -o BatchMode=yes${scpPortFlag}`;

  return text.replace(
    /Start by running basic recon: hostname, uname -a, uptime\.\]/,
    `To run commands, use the exec tool with:\n${sshPrefix} <command>\n\n` +
    `For file transfers:\n` +
    `${scpPrefix} <local> ${targetUser}@${targetHost}:<remote>\n` +
    `${scpPrefix} ${targetUser}@${targetHost}:<remote> <local>\n\n` +
    `Start by running basic recon: hostname, uname -a, uptime.]`
  );
}

/**
 * Handle an inbound chat message from the Clawdfather web UI.
 * Routes through OpenClaw's channel system for agent processing.
 */
export async function handleClawdfatherInbound(params: {
  sessionId: string;
  text: string;
  keyFingerprint: string;
  accountId: string;
  config: any;
}): Promise<void> {
  const core = getClawdfatherRuntime();
  const { sessionId, keyFingerprint, accountId, config } = params;
  const text = enrichWithSSHContext(params.text, sessionId);

  const peerId = sessionId;

  // Resolve agent routing
  const route = core.channel.routing.resolveAgentRoute({
    channel: CHANNEL_ID,
    peerId,
    chatType: "direct",
    cfg: config,
  });

  // Resolve session store path
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });

  // Build context payload
  const ctxPayload = core.channel.context.buildContextPayload({
    SessionKey: route.sessionKey,
    Channel: CHANNEL_ID,
    To: `${CHANNEL_ID}:${peerId}`,
    AccountId: accountId,
    ChatType: "direct",
    ConversationLabel: `SSH ${sessionId.slice(0, 8)}`,
    SenderName: keyFingerprint,
    SenderId: keyFingerprint,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: `cf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    Timestamp: Date.now(),
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `${CHANNEL_ID}:${peerId}`,
    Body: text,
  });

  // Record inbound session
  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err: Error) => {
      console.error(`[clawdfather] Failed recording session: ${err.message}`);
    },
  });

  // Record activity
  core.channel.activity.record({
    channel: CHANNEL_ID,
    accountId,
    direction: "inbound",
    at: Date.now(),
  });

  const createPrefixOptions = core.channel?.reply?.createReplyPrefixOptions;
  const prefixResult = typeof createPrefixOptions === "function"
    ? createPrefixOptions({ cfg: config, agentId: route.agentId, channel: CHANNEL_ID, accountId })
    : {};
  const { onModelSelected: _onModelSelected, ...prefixOptions } = prefixResult;

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string }) => {
        const responseText = payload.text ?? "";
        if (responseText.trim()) {
          sendToSession(sessionId, {
            type: "message",
            role: "assistant",
            text: responseText,
          });

          // Record outbound activity
          core.channel.activity.record({
            channel: CHANNEL_ID,
            accountId,
            direction: "outbound",
          });
        }
      },
    },
  });
}
