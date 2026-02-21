(function () {
  "use strict";

  // ── Configuration ──────────────────────────────────────────────────
  const API = "/api/v1";
  const TOKEN_KEY = "clf_token";
  const VERSION = "0.2.0";

  // ── State ──────────────────────────────────────────────────────────
  let token = localStorage.getItem(TOKEN_KEY);
  let account = null;
  let connections = [];
  let keypairs = [];
  let sessions = [];
  let currentView = "connections";
  let ws = null;
  let wsAuthenticated = false;
  let heartbeatTimer = null;
  let chatTimerInterval = null;
  let chatSessionId = null;
  let chatStartedAt = null;
  let isThinking = false;

  // ── DOM References ─────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const screenAuth = $("screen-auth");
  const appShell = $("app-shell");
  const btnGithubLogin = $("btn-github-login");
  const authError = $("auth-error");
  const headerAccountName = $("header-account-name");
  const headerAvatar = $("header-avatar");
  const bottomNav = $("bottom-nav");

  const viewConnections = $("view-connections");
  const connectionsLoading = $("connections-loading");
  const connectionsEmpty = $("connections-empty");
  const connectionsList = $("connections-list");
  const fabAddConnection = $("fab-add-connection");

  const viewSessions = $("view-sessions");
  const sessionsLoading = $("sessions-loading");
  const sessionsEmpty = $("sessions-empty");
  const sessionsList = $("sessions-list");

  const viewSettings = $("view-settings");
  const settingsAvatar = $("settings-avatar");
  const settingsDisplayName = $("settings-display-name");
  const settingsEmail = $("settings-email");
  const settingsVersion = $("settings-version");
  const keysList = $("keys-list");
  const btnGenerateKey = $("btn-generate-key");
  const btnSignOut = $("btn-sign-out");

  const viewChat = $("view-chat");
  const chatConnectionLabel = $("chat-connection-label");
  const chatTimer = $("chat-timer");
  const chatMessages = $("chat-messages");
  const chatInput = $("chat-input");
  const btnChatSend = $("btn-chat-send");
  const btnEndSession = $("btn-end-session");

  const sheetBackdrop = $("sheet-backdrop");
  const sheet = $("sheet");
  const sheetTitle = $("sheet-title");
  const sheetContent = $("sheet-content");

  const toastContainer = $("toast-container");

  // ── API Helpers ────────────────────────────────────────────────────
  async function api(method, path, body) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = "Bearer " + token;

    const opts = { method, headers };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const res = await fetch(API + path, opts);

    if (res.status === 401) {
      logout();
      throw new Error("Session expired");
    }

    const data = await res.json();
    if (!res.ok) {
      const msg = data.message || data.error || "Request failed";
      throw Object.assign(new Error(msg), { status: res.status, code: data.code, data });
    }
    return data;
  }

  // ── Toast Notifications ────────────────────────────────────────────
  function showToast(message, type) {
    type = type || "info";
    var el = document.createElement("div");
    el.className = "toast toast-" + type;
    el.textContent = message;
    toastContainer.appendChild(el);
    setTimeout(function () {
      el.classList.add("toast-exit");
      setTimeout(function () { el.remove(); }, 300);
    }, 3000);
  }

  // ── Auth ───────────────────────────────────────────────────────────
  function showAuthScreen() {
    screenAuth.classList.add("active");
    appShell.hidden = true;
    authError.hidden = true;
  }

  function showApp() {
    screenAuth.classList.remove("active");
    appShell.hidden = false;
  }

  function showAuthError(msg) {
    authError.textContent = msg;
    authError.hidden = false;
  }

  function logout() {
    if (token) {
      api("DELETE", "/auth/session").catch(function () {});
    }
    token = null;
    account = null;
    localStorage.removeItem(TOKEN_KEY);
    disconnectWs();
    showAuthScreen();
  }

  async function startGitHubOAuth() {
    btnGithubLogin.disabled = true;
    try {
      var data = await api("POST", "/auth/oauth/github/start");
      window.location.href = data.authorize_url;
    } catch (err) {
      showAuthError(err.message);
      btnGithubLogin.disabled = false;
    }
  }

  async function handleOAuthCallback(code, state) {
    showAuthScreen();
    try {
      var res = await fetch(
        API + "/auth/oauth/github/callback?code=" + encodeURIComponent(code) + "&state=" + encodeURIComponent(state)
      );
      var data = await res.json();
      if (!res.ok) {
        showAuthError(data.message || "OAuth callback failed");
        return;
      }
      token = data.token;
      localStorage.setItem(TOKEN_KEY, token);
      account = data.account;
      window.history.replaceState(null, "", window.location.pathname);
      bootApp();
    } catch (err) {
      showAuthError(err.message || "OAuth callback failed");
    }
  }

  // ── App Boot ───────────────────────────────────────────────────────
  async function bootApp() {
    showApp();
    settingsVersion.textContent = VERSION;
    try {
      var me = await api("GET", "/auth/me");
      account = me.account;
      renderHeader();
      renderSettings();
    } catch (err) {
      if (err.message !== "Session expired") {
        showToast("Failed to load account: " + err.message, "error");
      }
      return;
    }
    navigate(currentView);
  }

  function renderHeader() {
    if (!account) return;
    headerAccountName.textContent = account.display_name || "";
    var initial = (account.display_name || "?")[0].toUpperCase();
    headerAvatar.textContent = initial;
  }

  // ── Navigation ─────────────────────────────────────────────────────
  window.navigate = function (view) {
    currentView = view;

    viewConnections.hidden = view !== "connections";
    viewSessions.hidden = view !== "sessions";
    viewSettings.hidden = view !== "settings";
    viewChat.hidden = true;
    viewChat.classList.remove("active-chat");

    bottomNav.hidden = false;

    document.querySelectorAll(".nav-tab").forEach(function (tab) {
      tab.classList.toggle("active", tab.getAttribute("data-view") === view);
    });

    if (view === "connections") loadConnections();
    else if (view === "sessions") loadSessions();
    else if (view === "settings") loadSettings();
  };

  // ── Connections ────────────────────────────────────────────────────
  async function loadConnections() {
    connectionsLoading.hidden = false;
    connectionsEmpty.hidden = true;
    connectionsList.hidden = true;
    fabAddConnection.hidden = true;

    try {
      var data = await api("GET", "/connections");
      connections = data.connections || [];

      var kData = await api("GET", "/keys");
      keypairs = (kData.keypairs || []).filter(function (k) { return k.is_active; });
    } catch (err) {
      connectionsLoading.hidden = true;
      showToast("Failed to load connections: " + err.message, "error");
      return;
    }

    connectionsLoading.hidden = true;
    if (connections.length === 0) {
      connectionsEmpty.hidden = false;
    } else {
      connectionsList.hidden = false;
      fabAddConnection.hidden = false;
      renderConnections();
    }
  }

  function renderConnections() {
    connectionsList.innerHTML = "";
    connections.forEach(function (conn) {
      var statusClass = "pill-gray";
      var statusLabel = "Untested";
      if (conn.last_test_result === "ok") {
        statusClass = "pill-success";
        statusLabel = "Tested";
      } else if (conn.last_test_result === "failed" || conn.last_test_result === "timeout") {
        statusClass = "pill-danger";
        statusLabel = conn.last_test_result === "timeout" ? "Timeout" : "Failed";
      }

      var timeStr = conn.last_tested_at ? timeAgo(conn.last_tested_at) : "";

      var card = document.createElement("div");
      card.className = "card";
      card.innerHTML =
        '<div class="card-header">' +
          '<span class="card-label">' + esc(conn.label) + '</span>' +
          '<button class="card-menu" onclick="event.stopPropagation(); showConnectionMenu(\'' + conn.id + '\', this)">⋮</button>' +
        '</div>' +
        '<div class="card-host">' + esc(conn.username + "@" + conn.host + ":" + conn.port) + '</div>' +
        '<div class="card-footer">' +
          '<span class="pill ' + statusClass + '">' + statusLabel + '</span>' +
          (timeStr ? '<span class="card-time">' + esc(timeStr) + '</span>' : '') +
        '</div>';
      card.addEventListener("click", function () {
        showConnectionDetail(conn);
      });
      connectionsList.appendChild(card);
    });
  }

  // ── Connection Detail Sheet ────────────────────────────────────────
  function showConnectionDetail(conn) {
    openSheet(esc(conn.label));

    var statusPill = "pill-gray";
    var statusLabel = "Untested";
    if (conn.last_test_result === "ok") {
      statusPill = "pill-success";
      statusLabel = "Tested OK";
    } else if (conn.last_test_result === "failed" || conn.last_test_result === "timeout") {
      statusPill = "pill-danger";
      statusLabel = conn.last_test_result === "timeout" ? "Timed out" : "Failed";
    }

    sheetContent.innerHTML =
      '<div class="detail-row"><span class="detail-label">Host</span><span class="detail-value">' + esc(conn.host) + '</span></div>' +
      '<div class="detail-row"><span class="detail-label">Port</span><span class="detail-value">' + conn.port + '</span></div>' +
      '<div class="detail-row"><span class="detail-label">Username</span><span class="detail-value">' + esc(conn.username) + '</span></div>' +
      '<div class="detail-row"><span class="detail-label">Status</span><span class="pill ' + statusPill + '">' + statusLabel + '</span></div>' +
      (conn.last_tested_at ? '<div class="detail-row"><span class="detail-label">Last tested</span><span class="detail-value">' + esc(timeAgo(conn.last_tested_at)) + '</span></div>' : '') +
      '<div class="detail-actions">' +
        '<button class="btn btn-secondary" id="detail-btn-test">Test Connection</button>' +
        (conn.last_test_result === "ok" ? '<button class="btn btn-primary" id="detail-btn-session">Start Session</button>' : '') +
      '</div>' +
      '<button class="detail-delete" id="detail-btn-delete">Delete Connection</button>';

    $("detail-btn-test").addEventListener("click", function () { testConnection(conn.id); });

    var sessionBtn = $("detail-btn-session");
    if (sessionBtn) {
      sessionBtn.addEventListener("click", function () { startSession(conn.id); });
    }

    $("detail-btn-delete").addEventListener("click", function () { confirmDeleteConnection(conn.id, conn.label); });
  }

  // ── Connection Context Menu ────────────────────────────────────────
  window.showConnectionMenu = function (connId, btn) {
    closeContextMenu();
    var conn = connections.find(function (c) { return c.id === connId; });
    if (!conn) return;

    var rect = btn.getBoundingClientRect();
    var menu = document.createElement("div");
    menu.className = "context-menu";
    menu.id = "context-menu";
    menu.style.top = rect.bottom + 4 + "px";
    menu.style.right = (window.innerWidth - rect.right) + "px";

    menu.innerHTML =
      '<button class="context-menu-item" data-action="test">Test Connection</button>' +
      (conn.last_test_result === "ok" ? '<button class="context-menu-item" data-action="session">Start Session</button>' : '') +
      '<button class="context-menu-item danger" data-action="delete">Delete</button>';

    menu.addEventListener("click", function (e) {
      var action = e.target.getAttribute("data-action");
      closeContextMenu();
      if (action === "test") testConnection(connId);
      else if (action === "session") startSession(connId);
      else if (action === "delete") confirmDeleteConnection(connId, conn.label);
    });

    document.body.appendChild(menu);

    setTimeout(function () {
      document.addEventListener("click", closeContextMenu, { once: true });
    }, 0);
  };

  function closeContextMenu() {
    var m = $("context-menu");
    if (m) m.remove();
  }

  // ── Test Connection ────────────────────────────────────────────────
  async function testConnection(connId) {
    closeSheet();
    closeContextMenu();

    openSheet("Testing Connection");
    sheetContent.innerHTML =
      '<div class="test-result"><div class="spinner"></div><p>Connecting via SSH...</p></div>';

    try {
      var result = await api("POST", "/connections/" + connId + "/test");
      if (result.result === "ok") {
        sheetContent.innerHTML =
          '<div class="test-result">' +
            '<div class="test-result-icon">✅</div>' +
            '<div class="test-result-title">Connection Successful</div>' +
            '<div class="test-result-detail">' + (result.latency_ms ? result.latency_ms + "ms latency" : "") + '</div>' +
          '</div>' +
          '<button class="btn btn-primary btn-block" id="test-done-btn">Done</button>';
        $("test-done-btn").addEventListener("click", function () {
          closeSheet();
          loadConnections();
        });
      } else {
        sheetContent.innerHTML =
          '<div class="test-result">' +
            '<div class="test-result-icon">❌</div>' +
            '<div class="test-result-title">' + esc(result.result === "timeout" ? "Timed Out" : "Connection Failed") + '</div>' +
            '<div class="test-result-detail">' + esc(result.message || "") + '</div>' +
          '</div>' +
          '<button class="btn btn-secondary btn-block" id="test-done-btn">Close</button>';
        $("test-done-btn").addEventListener("click", function () {
          closeSheet();
          loadConnections();
        });
      }
    } catch (err) {
      if (err.code === "host_key_changed" && err.data) {
        renderHostKeyWarning(connId, err.data);
      } else {
        sheetContent.innerHTML =
          '<div class="test-result">' +
            '<div class="test-result-icon">❌</div>' +
            '<div class="test-result-title">Error</div>' +
            '<div class="test-result-detail">' + esc(err.message) + '</div>' +
          '</div>' +
          '<button class="btn btn-secondary btn-block" id="test-done-btn">Close</button>';
        $("test-done-btn").addEventListener("click", closeSheet);
      }
    }
  }

  function renderHostKeyWarning(connId, data) {
    sheetContent.innerHTML =
      '<div class="host-key-warning">' +
        '<div class="host-key-warning-title">⚠️ Host Key Changed</div>' +
        '<div class="host-key-warning-text">The server\'s SSH host key has changed since the last test. This could indicate a server reinstall or a man-in-the-middle attack.</div>' +
        '<div class="host-key-fingerprints">' +
          '<div class="host-key-fp-row"><span class="host-key-fp-label">Old:</span><span class="host-key-fp-value">' + esc(data.old_fingerprint || "") + '</span></div>' +
          '<div class="host-key-fp-row"><span class="host-key-fp-label">New:</span><span class="host-key-fp-value">' + esc(data.new_fingerprint || "") + '</span></div>' +
        '</div>' +
        '<div class="host-key-actions">' +
          '<button class="btn btn-secondary" id="hk-cancel">Cancel</button>' +
          '<button class="btn btn-primary" id="hk-accept">Accept New Key</button>' +
        '</div>' +
      '</div>';

    $("hk-cancel").addEventListener("click", function () {
      closeSheet();
      loadConnections();
    });
    $("hk-accept").addEventListener("click", async function () {
      try {
        await api("POST", "/connections/" + connId + "/test", { accept_host_key: true });
        showToast("Host key updated", "success");
        closeSheet();
        loadConnections();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }

  // ── Add Connection Sheet ───────────────────────────────────────────
  window.showAddConnectionSheet = function () {
    openSheet("Add Connection");

    var keypairOptions = keypairs.map(function (kp) {
      return '<option value="' + kp.id + '">' + esc(kp.label) + ' (' + esc((kp.fingerprint || "").slice(0, 20)) + '...)</option>';
    }).join("");

    sheetContent.innerHTML =
      '<form id="add-connection-form">' +
        '<div class="form-group">' +
          '<label class="form-label">Label</label>' +
          '<input class="form-input" id="conn-label" placeholder="My Server" required autocomplete="off">' +
        '</div>' +
        '<div class="form-group">' +
          '<label class="form-label">Host</label>' +
          '<input class="form-input" id="conn-host" placeholder="192.168.1.100 or server.example.com" required autocomplete="off">' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="form-group">' +
            '<label class="form-label">Username</label>' +
            '<input class="form-input" id="conn-username" placeholder="root" required autocomplete="off">' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">Port</label>' +
            '<input class="form-input" id="conn-port" type="number" placeholder="22" value="22">' +
          '</div>' +
        '</div>' +
        (keypairOptions
          ? '<div class="form-group">' +
              '<label class="form-label">SSH Key</label>' +
              '<select class="form-select" id="conn-keypair">' + keypairOptions + '</select>' +
            '</div>'
          : '<div class="form-group"><p class="form-error">No SSH keys found. Generate one in Settings first.</p></div>'
        ) +
        '<div id="conn-form-error" class="form-error" hidden></div>' +
        '<button type="submit" class="btn btn-primary btn-block mt-16"' + (keypairOptions ? '' : ' disabled') + '>Add Connection</button>' +
      '</form>';

    $("add-connection-form").addEventListener("submit", function (e) {
      e.preventDefault();
      submitAddConnection();
    });
  };

  async function submitAddConnection() {
    var label = $("conn-label").value.trim();
    var host = $("conn-host").value.trim();
    var username = $("conn-username").value.trim();
    var port = parseInt($("conn-port").value, 10) || 22;
    var keypairSelect = $("conn-keypair");
    var keypairId = keypairSelect ? keypairSelect.value : undefined;
    var errEl = $("conn-form-error");

    errEl.hidden = true;

    if (!label || !host || !username) {
      errEl.textContent = "All fields are required.";
      errEl.hidden = false;
      return;
    }

    try {
      var data = await api("POST", "/connections", {
        label: label,
        host: host,
        port: port,
        username: username,
        keypair_id: keypairId,
      });
      showToast("Connection added", "success");
      closeSheet();

      if (data.connection && data.connection.keypair_id) {
        showInstallKeySheet(data.connection);
      } else {
        loadConnections();
      }
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  }

  // ── Install Key Sheet ──────────────────────────────────────────────
  async function showInstallKeySheet(conn) {
    openSheet("Install SSH Key");

    sheetContent.innerHTML =
      '<p style="color: var(--text-secondary); margin-bottom: 16px; font-size: 14px; line-height: 1.6;">' +
        'Run this command on <strong>' + esc(conn.username + "@" + conn.host) + '</strong> to authorize Clawdfather\'s SSH key:' +
      '</p>' +
      '<div class="command-box" id="install-command-text">Loading...</div>' +
      '<button class="btn btn-secondary btn-block mb-16" id="copy-install-cmd">Copy Command</button>' +
      '<button class="btn btn-primary btn-block" id="install-done-btn">Done, Test Connection</button>';

    try {
      var kpId = conn.keypair_id;
      var data = await api("GET", "/keys/" + kpId + "/install-command");
      $("install-command-text").textContent = data.command;

      $("copy-install-cmd").addEventListener("click", function () {
        navigator.clipboard.writeText(data.command).then(function () {
          showToast("Command copied!", "success");
        }).catch(function () {
          showToast("Copy failed — select manually", "warning");
        });
      });
    } catch (err) {
      $("install-command-text").textContent = "Failed to load install command: " + err.message;
    }

    $("install-done-btn").addEventListener("click", function () {
      closeSheet();
      testConnection(conn.id);
    });
  }

  // ── Delete Connection ──────────────────────────────────────────────
  function confirmDeleteConnection(connId, label) {
    closeSheet();
    openSheet("Delete Connection");

    sheetContent.innerHTML =
      '<p class="confirm-text">Are you sure you want to delete <strong>' + esc(label) + '</strong>? This cannot be undone.</p>' +
      '<div class="confirm-actions">' +
        '<button class="btn btn-secondary" id="delete-cancel">Cancel</button>' +
        '<button class="btn btn-danger-text" id="delete-confirm">Delete</button>' +
      '</div>';

    $("delete-cancel").addEventListener("click", closeSheet);
    $("delete-confirm").addEventListener("click", async function () {
      try {
        await api("DELETE", "/connections/" + connId);
        showToast("Connection deleted", "success");
        closeSheet();
        loadConnections();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }

  // ── Sessions ───────────────────────────────────────────────────────
  async function loadSessions() {
    sessionsLoading.hidden = false;
    sessionsEmpty.hidden = true;
    sessionsList.hidden = true;

    try {
      var data = await api("GET", "/sessions");
      sessions = data.sessions || [];
    } catch (err) {
      sessionsLoading.hidden = true;
      showToast("Failed to load sessions: " + err.message, "error");
      return;
    }

    sessionsLoading.hidden = true;
    if (sessions.length === 0) {
      sessionsEmpty.hidden = false;
    } else {
      sessionsList.hidden = false;
      renderSessions();
    }
  }

  function renderSessions() {
    sessionsList.innerHTML = "";
    sessions.forEach(function (sess) {
      var isActive = sess.status === "active" || sess.status === "pending";
      var pillClass = isActive ? "pill-active" : (sess.status === "error" ? "pill-danger" : "pill-gray");
      var connLabel = (sess.connection && sess.connection.label) || "Unknown";
      var connHost = (sess.connection && sess.connection.host) || "";

      var card = document.createElement("div");
      card.className = "session-card";
      card.innerHTML =
        '<div class="session-card-header">' +
          '<span class="session-card-label">' + esc(connLabel) + '</span>' +
          '<span class="pill ' + pillClass + '">' + esc(sess.status) + '</span>' +
        '</div>' +
        '<div class="session-card-host">' + esc(connHost) + '</div>' +
        '<div class="session-card-footer">' +
          '<span class="card-time">' + (sess.started_at ? timeAgo(sess.started_at) : "") + '</span>' +
          (isActive ? '<button class="btn btn-primary">Open Chat</button>' : '') +
        '</div>';

      if (isActive) {
        card.addEventListener("click", function () {
          openChat(sess);
        });
      }

      sessionsList.appendChild(card);
    });
  }

  // ── Start Session ──────────────────────────────────────────────────
  async function startSession(connectionId) {
    closeSheet();
    closeContextMenu();
    showToast("Starting session...", "info");

    try {
      var data = await api("POST", "/sessions", { connection_id: connectionId });
      showToast("Session started", "success");
      openChat(data.session);
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  // ── Chat View ──────────────────────────────────────────────────────
  function openChat(session) {
    chatSessionId = session.id;
    chatStartedAt = session.started_at ? new Date(session.started_at) : new Date();

    var label = (session.connection && session.connection.label) || "Session";
    chatConnectionLabel.textContent = label;
    chatMessages.innerHTML = "";
    chatInput.value = "";
    chatInput.disabled = false;
    btnChatSend.disabled = false;

    viewConnections.hidden = true;
    viewSessions.hidden = true;
    viewSettings.hidden = true;
    viewChat.hidden = false;
    viewChat.style.display = "flex";
    viewChat.classList.add("active-chat");
    bottomNav.hidden = true;

    updateChatTimer();
    chatTimerInterval = setInterval(updateChatTimer, 1000);

    addChatSystemMessage("Connecting to session...");
    connectWs(chatSessionId);
  }

  window.exitChat = function () {
    disconnectWs();
    viewChat.hidden = true;
    viewChat.style.display = "";
    viewChat.classList.remove("active-chat");
    if (chatTimerInterval) {
      clearInterval(chatTimerInterval);
      chatTimerInterval = null;
    }
    chatSessionId = null;
    navigate(currentView);
  };

  window.endCurrentSession = function () {
    if (!chatSessionId) return;
    openSheet("End Session");
    sheetContent.innerHTML =
      '<p class="confirm-text">End this session? The SSH connection will be closed.</p>' +
      '<div class="confirm-actions">' +
        '<button class="btn btn-secondary" id="end-cancel">Cancel</button>' +
        '<button class="btn btn-danger-text" id="end-confirm">End Session</button>' +
      '</div>';

    $("end-cancel").addEventListener("click", closeSheet);
    $("end-confirm").addEventListener("click", async function () {
      closeSheet();
      try {
        await api("DELETE", "/sessions/" + chatSessionId);
        showToast("Session ended", "success");
        exitChat();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  };

  function updateChatTimer() {
    if (!chatStartedAt) return;
    var elapsed = Math.floor((Date.now() - chatStartedAt.getTime()) / 1000);
    var h = Math.floor(elapsed / 3600);
    var m = Math.floor((elapsed % 3600) / 60);
    var s = elapsed % 60;
    chatTimer.textContent =
      (h > 0 ? pad(h) + ":" : "") + pad(m) + ":" + pad(s);
  }

  function pad(n) { return n < 10 ? "0" + n : String(n); }

  // ── Chat Messages ──────────────────────────────────────────────────
  function addChatMessage(role, text) {
    var div = document.createElement("div");
    div.className = "chat-msg " + role;

    var header = document.createElement("div");
    header.className = "chat-msg-header";

    var sender = document.createElement("span");
    sender.className = "chat-msg-sender " + role;
    sender.textContent = role === "user" ? "You" : role === "assistant" ? "Clawdfather" : "System";

    var time = document.createElement("span");
    time.className = "chat-msg-time";
    time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    header.appendChild(sender);
    header.appendChild(time);

    var body = document.createElement("div");
    body.className = "chat-msg-body";
    body.innerHTML = renderMarkdown(text);

    body.querySelectorAll("pre").forEach(function (pre) {
      var btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.textContent = "copy";
      btn.style.cssText = "position:absolute;top:6px;right:8px;background:var(--card);border:1px solid var(--border);border-radius:4px;color:var(--text-secondary);font-size:11px;padding:2px 8px;cursor:pointer;";
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
    chatMessages.appendChild(div);
    scrollChat();
  }

  function addChatSystemMessage(text) { addChatMessage("system", text); }

  function showThinking() {
    if (isThinking) return;
    isThinking = true;
    var div = document.createElement("div");
    div.className = "chat-thinking";
    div.id = "thinking-indicator";
    div.innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span></div> Thinking...';
    chatMessages.appendChild(div);
    scrollChat();
  }

  function removeThinking() {
    isThinking = false;
    var el = $("thinking-indicator");
    if (el) el.remove();
  }

  function scrollChat() {
    requestAnimationFrame(function () {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    });
  }

  // ── Chat Input ─────────────────────────────────────────────────────
  window.sendChatMessage = function () {
    var text = chatInput.value.trim();
    if (!text || !wsAuthenticated) return;

    addChatMessage("user", text);
    ws.send(JSON.stringify({ type: "message", text: text }));
    chatInput.value = "";
    chatInput.style.height = "auto";
  };

  chatInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  chatInput.addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 120) + "px";
  });

  // ── WebSocket ──────────────────────────────────────────────────────
  function connectWs(sessionId) {
    disconnectWs();
    wsAuthenticated = false;

    var proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    var host = window.location.host;
    var wsUrl = proto + "//" + host + "/ws/sessions/" + sessionId;

    ws = new WebSocket(wsUrl);

    ws.onopen = function () {
      ws.send(JSON.stringify({ type: "auth", token: token, session_id: sessionId }));
    };

    ws.onmessage = function (event) {
      try {
        var msg = JSON.parse(event.data);
        handleWsMessage(msg);
      } catch (e) {
        console.error("WS parse error:", e);
      }
    };

    ws.onclose = function (event) {
      wsAuthenticated = false;
      stopHeartbeat();
      if (event.code === 4001) {
        addChatSystemMessage("Session has ended.");
        chatInput.disabled = true;
        btnChatSend.disabled = true;
      } else if (chatSessionId === sessionId) {
        addChatSystemMessage("Disconnected. Attempting to reconnect...");
        setTimeout(function () {
          if (chatSessionId === sessionId) connectWs(sessionId);
        }, 2000);
      }
    };

    ws.onerror = function () {};
  }

  function disconnectWs() {
    stopHeartbeat();
    wsAuthenticated = false;
    if (ws) {
      try { ws.close(); } catch (e) {}
      ws = null;
    }
  }

  function handleWsMessage(msg) {
    switch (msg.type) {
      case "session":
        wsAuthenticated = true;
        removeThinking();
        addChatSystemMessage("Connected" + (msg.connection ? " to " + msg.connection.label : ""));
        startHeartbeat();
        break;

      case "auth_ok":
        wsAuthenticated = true;
        startHeartbeat();
        break;

      case "message":
        removeThinking();
        if (msg.role === "assistant") {
          addChatMessage("assistant", msg.text || "");
        } else if (msg.role === "user") {
          // already shown locally
        } else {
          addChatMessage("system", msg.text || "");
        }
        break;

      case "status":
        if (msg.status === "thinking") showThinking();
        else if (msg.status === "done") removeThinking();
        break;

      case "error":
        removeThinking();
        addChatSystemMessage("Error: " + (msg.message || "Unknown error"));
        break;

      case "heartbeat_ack":
        break;

      default:
        console.log("Unknown WS message:", msg.type);
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(function () {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, 30000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // ── Settings ───────────────────────────────────────────────────────
  async function loadSettings() {
    renderSettings();
    await loadKeys();
  }

  function renderSettings() {
    if (!account) return;
    settingsDisplayName.textContent = account.display_name || "—";
    settingsEmail.textContent = account.email || "No email";
    settingsVersion.textContent = VERSION;

    var initial = (account.display_name || "?")[0].toUpperCase();
    settingsAvatar.textContent = initial;
  }

  async function loadKeys() {
    keysList.innerHTML = '<div class="loading-state" style="padding: 24px 0;"><div class="spinner"></div></div>';
    try {
      var data = await api("GET", "/keys");
      keypairs = data.keypairs || [];
      renderKeys();
    } catch (err) {
      keysList.innerHTML = '<p style="padding: 16px; color: var(--text-secondary);">Failed to load keys</p>';
    }
  }

  function renderKeys() {
    if (keypairs.length === 0) {
      keysList.innerHTML = '<p style="padding: 16px; color: var(--text-secondary);">No SSH keys yet.</p>';
      return;
    }

    keysList.innerHTML = "";
    keypairs.forEach(function (kp) {
      var item = document.createElement("div");
      item.className = "key-item";
      item.innerHTML =
        '<div class="key-item-header">' +
          '<span class="key-item-label">' + esc(kp.label) + '</span>' +
          '<span class="pill ' + (kp.is_active ? "pill-success" : "pill-gray") + '">' + (kp.is_active ? "Active" : "Revoked") + '</span>' +
        '</div>' +
        '<div class="key-item-fingerprint">' + esc(kp.fingerprint || "") + '</div>';

      item.addEventListener("click", function () {
        showKeyDetail(kp);
      });

      keysList.appendChild(item);
    });
  }

  function showKeyDetail(kp) {
    openSheet(esc(kp.label));
    sheetContent.innerHTML =
      '<div class="detail-row"><span class="detail-label">Algorithm</span><span class="detail-value">' + esc(kp.algorithm || "ed25519") + '</span></div>' +
      '<div class="detail-row"><span class="detail-label">Fingerprint</span><span class="detail-value">' + esc(kp.fingerprint || "") + '</span></div>' +
      '<div class="detail-row"><span class="detail-label">Status</span><span class="pill ' + (kp.is_active ? "pill-success" : "pill-gray") + '">' + (kp.is_active ? "Active" : "Revoked") + '</span></div>' +
      '<div class="detail-row"><span class="detail-label">Created</span><span class="detail-value">' + esc(timeAgo(kp.created_at)) + '</span></div>' +
      '<div class="detail-actions">' +
        '<button class="btn btn-secondary" id="key-install-btn">Install Command</button>' +
        (kp.is_active ? '<button class="btn btn-danger-text" id="key-revoke-btn">Revoke Key</button>' : '') +
      '</div>';

    $("key-install-btn").addEventListener("click", async function () {
      try {
        var data = await api("GET", "/keys/" + kp.id + "/install-command");
        closeSheet();
        openSheet("Install Command");
        sheetContent.innerHTML =
          '<div class="command-box">' + esc(data.command) + '</div>' +
          '<button class="btn btn-secondary btn-block" id="copy-key-cmd">Copy Command</button>' +
          '<button class="btn btn-primary btn-block mt-12" id="key-cmd-done">Done</button>';

        $("copy-key-cmd").addEventListener("click", function () {
          navigator.clipboard.writeText(data.command).then(function () {
            showToast("Copied!", "success");
          }).catch(function () {
            showToast("Copy failed", "warning");
          });
        });
        $("key-cmd-done").addEventListener("click", closeSheet);
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    var revokeBtn = $("key-revoke-btn");
    if (revokeBtn) {
      revokeBtn.addEventListener("click", async function () {
        try {
          await api("DELETE", "/keys/" + kp.id);
          showToast("Key revoked", "success");
          closeSheet();
          loadKeys();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    }
  }

  // ── Generate Key ───────────────────────────────────────────────────
  btnGenerateKey.addEventListener("click", function () {
    openSheet("Generate SSH Key");
    sheetContent.innerHTML =
      '<form id="gen-key-form">' +
        '<div class="form-group">' +
          '<label class="form-label">Label</label>' +
          '<input class="form-input" id="key-label-input" placeholder="default" value="default" autocomplete="off">' +
        '</div>' +
        '<div id="key-gen-error" class="form-error" hidden></div>' +
        '<button type="submit" class="btn btn-primary btn-block mt-16">Generate Key</button>' +
      '</form>';

    $("gen-key-form").addEventListener("submit", async function (e) {
      e.preventDefault();
      var label = $("key-label-input").value.trim() || "default";
      var errEl = $("key-gen-error");
      errEl.hidden = true;

      try {
        var data = await api("POST", "/keys", { label: label });
        showToast("Key generated", "success");
        closeSheet();
        loadKeys();

        keypairs.push(data.keypair);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    });
  });

  // ── Sign Out ───────────────────────────────────────────────────────
  btnSignOut.addEventListener("click", function () {
    openSheet("Sign Out");
    sheetContent.innerHTML =
      '<p class="confirm-text">Are you sure you want to sign out?</p>' +
      '<div class="confirm-actions">' +
        '<button class="btn btn-secondary" id="signout-cancel">Cancel</button>' +
        '<button class="btn btn-danger-text" id="signout-confirm">Sign Out</button>' +
      '</div>';

    $("signout-cancel").addEventListener("click", closeSheet);
    $("signout-confirm").addEventListener("click", function () {
      closeSheet();
      logout();
    });
  });

  // ── Bottom Sheet ───────────────────────────────────────────────────
  function openSheet(title) {
    sheetTitle.textContent = title;
    sheetContent.innerHTML = "";
    sheetBackdrop.hidden = false;
    sheet.hidden = false;
    requestAnimationFrame(function () {
      sheetBackdrop.classList.add("visible");
      sheet.classList.add("visible");
    });
  }

  window.closeSheet = function () {
    sheetBackdrop.classList.remove("visible");
    sheet.classList.remove("visible");
    setTimeout(function () {
      sheetBackdrop.hidden = true;
      sheet.hidden = true;
      sheetContent.innerHTML = "";
    }, 300);
  };

  sheetBackdrop.addEventListener("click", closeSheet);

  // ── Markdown Renderer ──────────────────────────────────────────────
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

  // ── Utilities ──────────────────────────────────────────────────────
  function esc(str) {
    if (!str) return "";
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(String(str)));
    return div.innerHTML;
  }

  function timeAgo(dateStr) {
    if (!dateStr) return "";
    var now = Date.now();
    var then = new Date(dateStr).getTime();
    var diff = Math.floor((now - then) / 1000);

    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return Math.floor(diff / 86400) + "d ago";
  }

  // ── Init ───────────────────────────────────────────────────────────
  function init() {
    var params = new URLSearchParams(window.location.search);
    var code = params.get("code");
    var state = params.get("state");

    if (code && state) {
      handleOAuthCallback(code, state);
      return;
    }

    if (token) {
      bootApp();
    } else {
      showAuthScreen();
    }
  }

  btnGithubLogin.addEventListener("click", startGitHubOAuth);

  init();
})();
