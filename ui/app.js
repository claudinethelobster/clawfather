/**
 * Clawfather Web UI — Client-side application
 *
 * Connects to OpenClaw Gateway WebSocket and provides a chat interface
 * for AI-powered server administration.
 */

(function () {
  "use strict";

  // ── DOM Elements ──────────────────────────────────────────────────
  const $messages = document.getElementById("messages");
  const $input = document.getElementById("message-input");
  const $sendBtn = document.getElementById("send-btn");
  const $statusBadge = document.getElementById("status-badge");
  const $statusText = document.getElementById("status-text");
  const $serverInfo = document.getElementById("server-info");
  const $targetDisplay = document.getElementById("target-display");
  const $sessionDisplay = document.getElementById("session-display");
  const $welcome = document.getElementById("welcome");
  const $inputArea = document.getElementById("input-area");

  // ── State ─────────────────────────────────────────────────────────
  let ws = null;
  let sessionId = null;
  let serverTarget = null;
  let messageHistory = [];
  let isThinking = false;
  let reconnectTimer = null;
  let reconnectDelay = 1000;

  // ── Init ──────────────────────────────────────────────────────────
  function init() {
    // Extract session from URL hash
    const hash = window.location.hash.slice(1);
    const params = new URLSearchParams(hash);
    sessionId = params.get("session");

    if (!sessionId) {
      showWelcome();
      return;
    }

    showChat();
    $sessionDisplay.textContent = sessionId.slice(0, 8) + "...";
    addSystemMessage("Connecting to OpenClaw Gateway...");
    connect();
  }

  // ── UI State ──────────────────────────────────────────────────────
  function showWelcome() {
    $welcome.style.display = "flex";
    $messages.style.display = "none";
    $inputArea.style.display = "none";
    $serverInfo.style.display = "none";
  }

  function showChat() {
    $welcome.style.display = "none";
    $messages.style.display = "block";
    $inputArea.style.display = "block";
    $serverInfo.style.display = "flex";
  }

  function setStatus(status) {
    $statusBadge.className = "status-badge " + status;
    $statusText.textContent = status;
  }

  // ── WebSocket ─────────────────────────────────────────────────────
  function connect() {
    if (ws && ws.readyState <= 1) return;

    setStatus("connecting");

    // Determine WS URL — same host as page, or from query param
    const urlParams = new URLSearchParams(window.location.search);
    let gatewayUrl = urlParams.get("gatewayUrl");

    if (!gatewayUrl) {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host || "localhost:18789";
      gatewayUrl = `${proto}//${host}`;
    }

    const wsUrl = gatewayUrl;

    ws = new WebSocket(wsUrl);

    ws.onopen = function () {
      setStatus("connected");
      reconnectDelay = 1000;
      addSystemMessage("Connected to gateway. Starting session...");

      // Fetch session info via HTTP API to get connection details
      fetch("/api/session/" + sessionId)
        .then(function (r) { return r.json(); })
        .then(function (info) {
          if (info.error) {
            addSystemMessage("Error: " + info.error);
            return;
          }

          serverTarget = info.targetUser + "@" + info.targetHost;
          $targetDisplay.textContent = serverTarget;

          var sshPrefix = "ssh -o ControlPath=" + info.controlPath +
            " -o ControlMaster=no -o BatchMode=yes" +
            (info.targetPort !== 22 ? " -p " + info.targetPort : "") +
            " " + info.targetUser + "@" + info.targetHost;

          var scpPrefix = "scp -o ControlPath=" + info.controlPath +
            " -o ControlMaster=no -o BatchMode=yes" +
            (info.targetPort !== 22 ? " -P " + info.targetPort : "");

          // Load chat history
          sendRpc("chat.history", { sessionKey: "clawfather:" + sessionId });

          // Send initial context with SSH prefix for the agent
          sendChat(
            "[System: Clawfather session active. Connected to " + serverTarget + ".\n\n" +
            "To run commands on the connected server, use the exec tool with:\n" +
            sshPrefix + " <command>\n\n" +
            "For interactive commands, use exec with pty:true.\n" +
            "For long-running commands, use exec with background:true and poll with the process tool.\n\n" +
            "For file transfers:\n" +
            scpPrefix + " <local> " + info.targetUser + "@" + info.targetHost + ":<remote>\n" +
            scpPrefix + " " + info.targetUser + "@" + info.targetHost + ":<remote> <local>\n\n" +
            "Start by running basic recon: hostname, uname -a, uptime.]"
          );
        })
        .catch(function (err) {
          addSystemMessage("Failed to fetch session info: " + err.message);
        });
    };

    ws.onmessage = function (event) {
      try {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch (e) {
        console.error("Failed to parse message:", e);
      }
    };

    ws.onclose = function () {
      setStatus("disconnected");
      scheduleReconnect();
    };

    ws.onerror = function (err) {
      console.error("WebSocket error:", err);
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
      connect();
    }, reconnectDelay);
  }

  function sendRpc(method, params) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ method, params, id: Date.now() }));
  }

  function sendChat(text) {
    sendRpc("chat.send", {
      message: text,
      sessionKey: "clawfather:" + sessionId,
    });
  }

  // ── Message Handling ──────────────────────────────────────────────
  function handleMessage(msg) {
    // RPC response
    if (msg.id && msg.result) {
      if (msg.result.target) {
        serverTarget = msg.result.target;
        $targetDisplay.textContent = serverTarget;
      }
      if (msg.result.messages) {
        // Chat history
        msg.result.messages.forEach((m) => {
          if (m.role === "assistant") addAssistantMessage(extractText(m.content));
          else if (m.role === "user") addUserMessage(extractText(m.content));
        });
        scrollToBottom();
      }
      return;
    }

    // Streaming chat events
    if (msg.type === "chat" || msg.event === "chat") {
      const data = msg.data || msg;

      if (data.role === "assistant" && data.content) {
        removeThinking();
        addAssistantMessage(extractText(data.content));
        scrollToBottom();
      }

      if (data.status === "thinking" || data.status === "running") {
        showThinking();
      }

      if (data.status === "done" || data.status === "complete") {
        removeThinking();
      }

      // Tool call output
      if (data.toolOutput || data.toolResult) {
        removeThinking();
        const output = data.toolOutput || extractText(data.toolResult?.content);
        if (output) {
          addAssistantMessage("```\n" + output + "\n```");
          scrollToBottom();
        }
      }
    }
  }

  function extractText(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    }
    return "";
  }

  // ── Render Messages ───────────────────────────────────────────────
  function addMessage(role, text) {
    const div = document.createElement("div");
    div.className = "message " + role;

    const header = document.createElement("div");
    header.className = "message-header";

    const sender = document.createElement("span");
    sender.className = "message-sender " + role;
    sender.textContent = role === "user" ? "You" : role === "assistant" ? "🦞 Clawfather" : "System";

    const time = document.createElement("span");
    time.className = "message-time";
    time.textContent = new Date().toLocaleTimeString();

    header.appendChild(sender);
    header.appendChild(time);

    const body = document.createElement("div");
    body.className = "message-body";
    body.innerHTML = renderMarkdown(text);

    // Add copy buttons to code blocks
    body.querySelectorAll("pre").forEach((pre) => {
      const btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.textContent = "copy";
      btn.onclick = () => {
        const code = pre.querySelector("code");
        navigator.clipboard.writeText(code ? code.textContent : pre.textContent);
        btn.textContent = "copied!";
        setTimeout(() => { btn.textContent = "copy"; }, 1500);
      };
      pre.style.position = "relative";
      pre.appendChild(btn);
    });

    div.appendChild(header);
    div.appendChild(body);
    $messages.appendChild(div);
    scrollToBottom();
  }

  function addUserMessage(text) { addMessage("user", text); }
  function addAssistantMessage(text) { addMessage("assistant", text); }
  function addSystemMessage(text) { addMessage("system", text); }

  function showThinking() {
    if (isThinking) return;
    isThinking = true;
    const div = document.createElement("div");
    div.className = "thinking";
    div.id = "thinking-indicator";
    div.innerHTML =
      '<div class="thinking-dots"><span></span><span></span><span></span></div>' +
      " Thinking...";
    $messages.appendChild(div);
    scrollToBottom();
  }

  function removeThinking() {
    isThinking = false;
    const el = document.getElementById("thinking-indicator");
    if (el) el.remove();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      $messages.scrollTop = $messages.scrollHeight;
    });
  }

  // ── Simple Markdown Renderer ──────────────────────────────────────
  function renderMarkdown(text) {
    if (!text) return "";

    // Escape HTML
    let html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Code blocks (```lang\n...\n```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
      return '<pre><code class="language-' + (lang || "text") + '">' + code.trim() + "</code></pre>";
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

    // Italic
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Line breaks (but not inside <pre>)
    html = html.replace(/\n/g, "<br>");
    // Fix double breaks inside pre (undo the damage)
    html = html.replace(/<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g, function (match) {
      return match.replace(/<br>/g, "\n");
    });

    return html;
  }

  // ── Input Handling ────────────────────────────────────────────────
  $input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  $input.addEventListener("input", function () {
    // Auto-resize textarea
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 200) + "px";
  });

  $sendBtn.addEventListener("click", send);

  function send() {
    const text = $input.value.trim();
    if (!text) return;

    addUserMessage(text);
    sendChat(text);
    $input.value = "";
    $input.style.height = "auto";
    showThinking();
  }

  // ── Hash change (new session) ─────────────────────────────────────
  window.addEventListener("hashchange", function () {
    const hash = window.location.hash.slice(1);
    const params = new URLSearchParams(hash);
    const newSession = params.get("session");
    if (newSession && newSession !== sessionId) {
      sessionId = newSession;
      $messages.innerHTML = "";
      if (ws) ws.close();
      showChat();
      $sessionDisplay.textContent = sessionId.slice(0, 8) + "...";
      addSystemMessage("Connecting to new session...");
      connect();
    }
  });

  // ── Start ─────────────────────────────────────────────────────────
  init();
})();
