/**
 * Clawdfather Web UI — Client-side application
 *
 * Connects to the Clawdfather plugin WebSocket server (not the OpenClaw Gateway).
 * Uses a simple JSON protocol for auth, chat messages, and status updates.
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
  let isThinking = false;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  let authenticated = false;

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
    addSystemMessage("Connecting...");
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
    authenticated = false;

    // Connect to plugin's WS server (same host, /ws path or root)
    var proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    var host = window.location.host || "localhost:3000";
    var wsUrl = proto + "//" + host;

    ws = new WebSocket(wsUrl);

    ws.onopen = function () {
      setStatus("connecting");
      // Authenticate with session ID
      ws.send(JSON.stringify({ type: "auth", sessionId: sessionId }));
    };

    ws.onmessage = function (event) {
      try {
        var msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch (e) {
        console.error("Failed to parse message:", e);
      }
    };

    ws.onclose = function () {
      setStatus("disconnected");
      authenticated = false;
      scheduleReconnect();
    };

    ws.onerror = function (err) {
      console.error("WebSocket error:", err);
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
      connect();
    }, reconnectDelay);
  }

  // ── Message Handling ──────────────────────────────────────────────
  function handleMessage(msg) {
    switch (msg.type) {
      case "session":
        // Authenticated + session info received
        authenticated = true;
        setStatus("connected");
        reconnectDelay = 1000;
        serverTarget = msg.targetUser + "@" + msg.targetHost;
        $targetDisplay.textContent = serverTarget;
        addSystemMessage("Connected to " + serverTarget);

        // Send initial context for the agent
        var sshPrefix = "ssh -o ControlPath=" + msg.controlPath +
          " -o ControlMaster=no -o BatchMode=yes" +
          (msg.targetPort !== 22 ? " -p " + msg.targetPort : "") +
          " " + msg.targetUser + "@" + msg.targetHost;

        var scpPrefix = "scp -o ControlPath=" + msg.controlPath +
          " -o ControlMaster=no -o BatchMode=yes" +
          (msg.targetPort !== 22 ? " -P " + msg.targetPort : "");

        sendMessage(
          "[System: Clawdfather session active. Connected to " + serverTarget + ".\n\n" +
          "To run commands on the connected server, use the exec tool with:\n" +
          sshPrefix + " <command>\n\n" +
          "For interactive commands, use exec with pty:true.\n" +
          "For long-running commands, use exec with background:true and poll with the process tool.\n\n" +
          "For file transfers:\n" +
          scpPrefix + " <local> " + msg.targetUser + "@" + msg.targetHost + ":<remote>\n" +
          scpPrefix + " " + msg.targetUser + "@" + msg.targetHost + ":<remote> <local>\n\n" +
          "Start by running basic recon: hostname, uname -a, uptime.]"
        );
        break;

      case "message":
        removeThinking();
        if (msg.role === "assistant") {
          addAssistantMessage(msg.text || "");
        }
        scrollToBottom();
        break;

      case "status":
        if (msg.status === "thinking") {
          showThinking();
        } else if (msg.status === "done") {
          removeThinking();
        }
        break;

      case "error":
        removeThinking();
        addSystemMessage("Error: " + (msg.message || "Unknown error"));
        break;

      default:
        console.log("Unknown message type:", msg.type);
    }
  }

  function sendMessage(text) {
    if (!ws || ws.readyState !== 1 || !authenticated) return;
    ws.send(JSON.stringify({ type: "message", text: text }));
  }

  // ── Render Messages ───────────────────────────────────────────────
  function addMessage(role, text) {
    var div = document.createElement("div");
    div.className = "message " + role;

    var header = document.createElement("div");
    header.className = "message-header";

    var sender = document.createElement("span");
    sender.className = "message-sender " + role;
    sender.textContent = role === "user" ? "You" : role === "assistant" ? "🦞 Clawdfather" : "System";

    var time = document.createElement("span");
    time.className = "message-time";
    time.textContent = new Date().toLocaleTimeString();

    header.appendChild(sender);
    header.appendChild(time);

    var body = document.createElement("div");
    body.className = "message-body";
    body.innerHTML = renderMarkdown(text);

    // Add copy buttons to code blocks
    body.querySelectorAll("pre").forEach(function (pre) {
      var btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.textContent = "copy";
      btn.onclick = function () {
        var code = pre.querySelector("code");
        navigator.clipboard.writeText(code ? code.textContent : pre.textContent);
        btn.textContent = "copied!";
        setTimeout(function () { btn.textContent = "copy"; }, 1500);
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
    var div = document.createElement("div");
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
    var el = document.getElementById("thinking-indicator");
    if (el) el.remove();
  }

  function scrollToBottom() {
    requestAnimationFrame(function () {
      $messages.scrollTop = $messages.scrollHeight;
    });
  }

  // ── Simple Markdown Renderer ──────────────────────────────────────
  function renderMarkdown(text) {
    if (!text) return "";

    var html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
      return '<pre><code class="language-' + (lang || "text") + '">' + code.trim() + "</code></pre>";
    });

    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    html = html.replace(/\n/g, "<br>");
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
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 200) + "px";
  });

  $sendBtn.addEventListener("click", send);

  function send() {
    var text = $input.value.trim();
    if (!text || !authenticated) return;

    addUserMessage(text);
    sendMessage(text);
    $input.value = "";
    $input.style.height = "auto";
  }

  // ── Hash change (new session) ─────────────────────────────────────
  window.addEventListener("hashchange", function () {
    var hash = window.location.hash.slice(1);
    var params = new URLSearchParams(hash);
    var newSession = params.get("session");
    if (newSession && newSession !== sessionId) {
      sessionId = newSession;
      $messages.innerHTML = "";
      authenticated = false;
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
