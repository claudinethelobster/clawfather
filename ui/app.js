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
  const $connectionHint = document.getElementById("connection-hint");
  const $accountLink = document.getElementById("account-link");

  // ── State ─────────────────────────────────────────────────────────
  let ws = null;
  let sessionId = null;
  let accountToken = null;
  let serverTarget = null;
  let isThinking = false;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  let authenticated = false;
  let bootstrapSent = false;
  let leaseEnded = false;

  // ── Welcome copy buttons ──────────────────────────────────────────
  function initWelcomeCopyButtons() {
    document.querySelectorAll(".step-copy-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var cmd = btn.getAttribute("data-cmd");
        if (!cmd) return;
        navigator.clipboard.writeText(cmd).then(function () {
          btn.textContent = "copied!";
          btn.classList.add("copied");
          setTimeout(function () {
            btn.textContent = "copy";
            btn.classList.remove("copied");
          }, 1500);
        }).catch(function () {
          var row = btn.closest(".step-cmd-row");
          var codeEl = row && row.querySelector(".step-cmd");
          if (codeEl) {
            var range = document.createRange();
            range.selectNodeContents(codeEl);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          }
        });
      });
    });
  }

  // ── Account link ─────────────────────────────────────────────────
  function enableAccountLink() {
    if ($accountLink && accountToken) {
      $accountLink.href = "account.html#account=" + accountToken;
      $accountLink.style.display = "";
    }
  }

  // ── Init ──────────────────────────────────────────────────────────
  function init() {
    initWelcomeCopyButtons();

    // Extract session + account token from URL hash then immediately scrub it
    const hash = window.location.hash.slice(1);
    const params = new URLSearchParams(hash);
    sessionId = params.get("session");
    accountToken = params.get("token") || params.get("account");

    if (sessionId || accountToken) {
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      } else {
        window.location.hash = "";
      }
    }

    if (accountToken) {
      enableAccountLink();
    }

    // Fetch version info
    fetch("/api/version").then(function(r) { return r.json(); }).then(function(v) {
      var el = document.getElementById("version-display");
      if (el) el.textContent = "v" + v.version + " (" + v.commit + ")";
    }).catch(function() {});

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
    var label = status;
    if (status === "lease-ended") label = "session ended";
    $statusText.textContent = label;
    if ($connectionHint) {
      if (status === "lease-ended") {
        $connectionHint.textContent = "Start a new SSH session to reconnect";
        $connectionHint.style.display = "";
      } else if (status === "disconnected" || status === "connecting") {
        $connectionHint.textContent = "ssh-add <key>, then ssh -A";
        $connectionHint.style.display = "";
      } else {
        $connectionHint.style.display = "none";
      }
    }
  }

  // ── WebSocket ─────────────────────────────────────────────────────
  function connect() {
    if (leaseEnded) return;
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

    ws.onclose = function (event) {
      authenticated = false;
      if (event.code === 4001) {
        leaseEnded = true;
        setStatus("lease-ended");
        addSystemMessage("Connection lease has ended. Your session is closed \u2014 start a new SSH session (`ssh -A`) to reconnect.");
        disableInput();
      } else {
        setStatus("disconnected");
        if (!leaseEnded) scheduleReconnect();
      }
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

        // Only send the bootstrap system prompt once per session to
        // avoid re-injecting context on every reconnect.
        if (!bootstrapSent) {
          bootstrapSent = true;
          sendMessage(
            "[System: Clawdfather session active. Connected to " + serverTarget +
            " (port " + (msg.targetPort || 22) + ").\n\n" +
            "To run commands on the connected server, use the exec tool with the " +
            "session's SSH ControlMaster (managed server-side).\n\n" +
            "For interactive commands, use exec with pty:true.\n" +
            "For long-running commands, use exec with background:true and poll with the process tool.\n\n" +
            "Start by running basic recon: hostname, uname -a, uptime.]"
          );
        }
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

  // ── Disable input (lease ended) ───────────────────────────────────
  function disableInput() {
    $input.disabled = true;
    $sendBtn.disabled = true;
    $inputArea.classList.add("disabled");

    // Add a sticky banner above the input to explain the state
    if (!document.getElementById("lease-ended-banner")) {
      var banner = document.createElement("div");
      banner.id = "lease-ended-banner";
      banner.className = "lease-ended-banner";
      banner.textContent = "\uD83D\uDD12 Connection lease has ended. Reconnect to continue.";
      // Insert before the input area so it appears above it
      $inputArea.parentNode.insertBefore(banner, $inputArea);
    }
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
    var newToken = params.get("token") || params.get("account");

    if (newToken) {
      accountToken = newToken;
      enableAccountLink();
    }

    if (newSession && newSession !== sessionId) {
      sessionId = newSession;
      bootstrapSent = false;
      leaseEnded = false;

      // Scrub token from URL immediately
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      } else {
        window.location.hash = "";
      }

      $messages.innerHTML = "";
      authenticated = false;
      $input.disabled = false;
      $sendBtn.disabled = false;
      $inputArea.classList.remove("disabled");
      // Remove lease-ended banner if present from previous session
      var oldBanner = document.getElementById("lease-ended-banner");
      if (oldBanner) oldBanner.remove();
      if (ws) ws.close();
      showChat();
      $sessionDisplay.textContent = sessionId.slice(0, 8) + "...";
      addSystemMessage("Connecting to new session...");
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      connect();
    }
  });

  // ── Start ─────────────────────────────────────────────────────────
  init();
})();
