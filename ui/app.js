/**
 * Clawdfather — Mobile-First Web UI
 * Single-page app: OAuth auth, connections, sessions, settings, chat.
 */
(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════
  // State
  // ═══════════════════════════════════════════════════════════════════

  const state = {
    token: localStorage.getItem('clf_token'),
    account: null,
    connections: [],
    keypairs: [],
    sessions: [],
    activeView: 'connections',
    activeChatSession: null,
    chatWs: null,
    chatTimer: null,
    chatStartedAt: null,
    loading: {},
  };

  // ═══════════════════════════════════════════════════════════════════
  // API Client
  // ═══════════════════════════════════════════════════════════════════

  async function api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;

    try {
      const res = await fetch(path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (res.status === 401) {
        logout();
        return null;
      }

      const data = await res.json();

      if (!res.ok) {
        const errMsg = data?.error?.message || data?.message || 'Request failed';
        throw new Error(errMsg);
      }

      return data;
    } catch (err) {
      if (err.message === 'Failed to fetch') {
        throw new Error('Network error. Check your connection and try again.');
      }
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Toast Notifications
  // ═══════════════════════════════════════════════════════════════════

  function showToast(message, type) {
    type = type || 'info';
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(function () {
      toast.classList.add('toast-exit');
      toast.addEventListener('animationend', function () { toast.remove(); });
    }, 3000);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Bottom Sheet
  // ═══════════════════════════════════════════════════════════════════

  function showSheet(title, contentHtml, onClose) {
    const backdrop = document.getElementById('sheet-backdrop');
    const sheet = document.getElementById('sheet');
    const titleEl = document.getElementById('sheet-title');
    const contentEl = document.getElementById('sheet-content');

    titleEl.textContent = title;
    contentEl.innerHTML = contentHtml;

    backdrop.hidden = false;
    sheet.hidden = false;

    requestAnimationFrame(function () {
      backdrop.classList.add('visible');
      sheet.classList.add('visible');
    });

    sheet._onClose = onClose || null;

    backdrop.onclick = function () { closeSheet(); };
  }

  window.closeSheet = function () {
    const backdrop = document.getElementById('sheet-backdrop');
    const sheet = document.getElementById('sheet');

    backdrop.classList.remove('visible');
    sheet.classList.remove('visible');

    setTimeout(function () {
      backdrop.hidden = true;
      sheet.hidden = true;
      if (sheet._onClose) sheet._onClose();
      sheet._onClose = null;
    }, 300);
  };

  // ═══════════════════════════════════════════════════════════════════
  // Context Menu
  // ═══════════════════════════════════════════════════════════════════

  function showContextMenu(x, y, items) {
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.id = 'context-menu';

    items.forEach(function (item) {
      const btn = document.createElement('button');
      btn.className = 'context-menu-item' + (item.danger ? ' danger' : '');
      btn.textContent = item.label;
      btn.onclick = function () {
        closeContextMenu();
        item.action();
      };
      menu.appendChild(btn);
    });

    const maxX = window.innerWidth - 180;
    const maxY = window.innerHeight - (items.length * 44 + 16);
    menu.style.left = Math.min(x, maxX) + 'px';
    menu.style.top = Math.min(y, maxY) + 'px';

    document.body.appendChild(menu);

    setTimeout(function () {
      document.addEventListener('click', closeContextMenu, { once: true });
    }, 10);
  }

  function closeContextMenu() {
    const existing = document.getElementById('context-menu');
    if (existing) existing.remove();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Navigation
  // ═══════════════════════════════════════════════════════════════════

  window.navigate = function (view) {
    if (state.activeView === view) return;
    state.activeView = view;

    document.querySelectorAll('.nav-tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.view === view);
    });

    ['connections', 'sessions', 'settings'].forEach(function (v) {
      const el = document.getElementById('view-' + v);
      if (el) el.hidden = v !== view;
    });

    if (view === 'connections') loadConnections();
    if (view === 'sessions') loadSessions();
    if (view === 'settings') loadSettings();
  };

  // ═══════════════════════════════════════════════════════════════════
  // Auth: OAuth Flow
  // ═══════════════════════════════════════════════════════════════════

  async function handleOAuthCallback() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('code') || !params.has('state')) return false;

    const code = params.get('code');
    const oauthState = params.get('state');

    try {
      const result = await api('GET',
        '/api/v1/auth/oauth/github/callback?code=' +
        encodeURIComponent(code) + '&state=' + encodeURIComponent(oauthState)
      );

      if (result && result.token) {
        state.token = result.token;
        localStorage.setItem('clf_token', result.token);
        if (result.account) state.account = result.account;
        window.history.replaceState({}, '', window.location.pathname);
        return true;
      }
    } catch (err) {
      showAuthError(err.message);
      window.history.replaceState({}, '', window.location.pathname);
    }

    return false;
  }

  async function startOAuth() {
    const btn = document.getElementById('btn-github-login');
    btn.disabled = true;
    btn.textContent = 'Connecting to GitHub...';
    hideAuthError();

    try {
      const data = await api('POST', '/api/v1/auth/oauth/github/start', {
        redirect_uri: window.location.origin + window.location.pathname,
      });
      if (data && data.authorize_url) {
        window.location.href = data.authorize_url;
        return;
      }
      throw new Error('No authorization URL returned');
    } catch (err) {
      showAuthError(err.message);
      btn.disabled = false;
      btn.innerHTML =
        '<svg class="github-icon" viewBox="0 0 16 16" width="20" height="20" fill="currentColor">' +
        '<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>' +
        '</svg> Sign in with GitHub';
    }
  }

  function showAuthError(msg) {
    const el = document.getElementById('auth-error');
    el.textContent = msg;
    el.hidden = false;
  }

  function hideAuthError() {
    document.getElementById('auth-error').hidden = true;
  }

  function logout() {
    api('DELETE', '/api/v1/auth/session').catch(function () {});
    state.token = null;
    state.account = null;
    localStorage.removeItem('clf_token');
    disconnectChat();
    showAuthScreen();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Screen Management
  // ═══════════════════════════════════════════════════════════════════

  function showAuthScreen() {
    document.getElementById('screen-auth').classList.add('active');
    document.getElementById('app-shell').hidden = true;
  }

  function showAppShell() {
    document.getElementById('screen-auth').classList.remove('active');
    document.getElementById('app-shell').hidden = false;
    navigate('connections');
  }

  // ═══════════════════════════════════════════════════════════════════
  // Account
  // ═══════════════════════════════════════════════════════════════════

  async function loadAccount() {
    try {
      const data = await api('GET', '/api/v1/auth/me');
      if (!data) return;
      state.account = data.account;
      updateAccountUI();
    } catch (err) {
      console.error('Failed to load account:', err);
    }
  }

  function updateAccountUI() {
    const acct = state.account;
    if (!acct) return;

    const initial = (acct.display_name || acct.email || '?')[0].toUpperCase();

    const headerAvatar = document.getElementById('header-avatar');
    headerAvatar.textContent = initial;

    const headerName = document.getElementById('header-account-name');
    headerName.textContent = acct.display_name || acct.email || '';

    const settingsAvatar = document.getElementById('settings-avatar');
    settingsAvatar.textContent = initial;

    const settingsName = document.getElementById('settings-display-name');
    settingsName.textContent = acct.display_name || 'Unknown';

    const settingsEmail = document.getElementById('settings-email');
    settingsEmail.textContent = acct.email || '';
  }

  // ═══════════════════════════════════════════════════════════════════
  // Connections
  // ═══════════════════════════════════════════════════════════════════

  async function loadConnections() {
    const loadingEl = document.getElementById('connections-loading');
    const emptyEl = document.getElementById('connections-empty');
    const listEl = document.getElementById('connections-list');
    const fabEl = document.getElementById('fab-add-connection');

    loadingEl.hidden = false;
    emptyEl.hidden = true;
    listEl.hidden = true;
    fabEl.hidden = true;

    try {
      const data = await api('GET', '/api/v1/connections');
      if (!data) return;

      state.connections = data.connections || [];
      loadingEl.hidden = true;

      if (state.connections.length === 0) {
        emptyEl.hidden = false;
      } else {
        listEl.hidden = false;
        fabEl.hidden = false;
        renderConnections();
      }
    } catch (err) {
      loadingEl.hidden = true;
      showToast('Failed to load connections: ' + err.message, 'error');
    }
  }

  function renderConnections() {
    const listEl = document.getElementById('connections-list');
    listEl.innerHTML = '';

    state.connections.forEach(function (conn) {
      const card = document.createElement('div');
      card.className = 'card';
      card.onclick = function () { showConnectionDetail(conn); };

      var pillClass, pillText;
      if (conn.last_test_result === 'ok') {
        pillClass = 'pill-success';
        pillText = '✓ Tested';
      } else if (conn.last_test_result === 'failed' || conn.last_test_result === 'timeout') {
        pillClass = 'pill-danger';
        pillText = '⚠ Test failed';
      } else {
        pillClass = 'pill-gray';
        pillText = 'Not tested';
      }

      var timeStr = '';
      if (conn.last_tested_at) {
        timeStr = formatRelativeTime(conn.last_tested_at);
      }

      card.innerHTML =
        '<div class="card-header">' +
          '<span class="card-label">' + escapeHtml(conn.label) + '</span>' +
          '<button class="card-menu" data-conn-id="' + conn.id + '">···</button>' +
        '</div>' +
        '<div class="card-host">' + escapeHtml(conn.username) + '@' + escapeHtml(conn.host) + ':' + (conn.port || 22) + '</div>' +
        '<div class="card-footer">' +
          '<span class="pill ' + pillClass + '">' + pillText + '</span>' +
          (timeStr ? '<span class="card-time">' + timeStr + '</span>' : '') +
        '</div>';

      var menuBtn = card.querySelector('.card-menu');
      menuBtn.onclick = function (e) {
        e.stopPropagation();
        showConnectionMenu(conn, e);
      };

      listEl.appendChild(card);
    });
  }

  function showConnectionMenu(conn, event) {
    var rect = event.target.getBoundingClientRect();
    showContextMenu(rect.left - 120, rect.bottom + 4, [
      { label: 'Edit', action: function () { showEditConnectionSheet(conn); } },
      { label: 'Test Connection', action: function () { testConnection(conn.id); } },
      { label: 'Delete', danger: true, action: function () { confirmDeleteConnection(conn); } },
    ]);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Add Connection Sheet
  // ═══════════════════════════════════════════════════════════════════

  window.showAddConnectionSheet = function () {
    loadKeypairsForForm().then(function (options) {
      showSheet('Add Connection',
        '<form id="form-add-conn" onsubmit="return false">' +
          '<div class="form-group">' +
            '<label class="form-label">Label</label>' +
            '<input class="form-input" id="add-conn-label" type="text" placeholder="e.g. prod-api-1" required autocomplete="off">' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">Host</label>' +
            '<input class="form-input" id="add-conn-host" type="text" placeholder="e.g. 192.168.1.100 or server.example.com" required autocomplete="off">' +
          '</div>' +
          '<div class="form-row">' +
            '<div class="form-group">' +
              '<label class="form-label">Username</label>' +
              '<input class="form-input" id="add-conn-username" type="text" placeholder="e.g. deploy" required autocomplete="off">' +
            '</div>' +
            '<div class="form-group" style="max-width:100px">' +
              '<label class="form-label">Port</label>' +
              '<input class="form-input" id="add-conn-port" type="number" value="22" min="1" max="65535" placeholder="22">' +
            '</div>' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">SSH Key</label>' +
            '<select class="form-select" id="add-conn-keypair">' + options + '</select>' +
          '</div>' +
          '<div id="add-conn-error" class="form-error" hidden></div>' +
          '<button class="btn btn-primary btn-block mt-16" onclick="submitAddConnection()">Add Connection</button>' +
        '</form>'
      );
    });
  };

  async function loadKeypairsForForm() {
    try {
      const data = await api('GET', '/api/v1/keys');
      if (!data) return '<option>No keys available</option>';
      state.keypairs = data.keypairs || [];
      return state.keypairs
        .filter(function (k) { return k.is_active; })
        .map(function (k) {
          return '<option value="' + k.id + '">' + escapeHtml(k.label) + ' (' + k.fingerprint.substring(0, 24) + '...)</option>';
        })
        .join('') || '<option>No active keys</option>';
    } catch (err) {
      return '<option>Error loading keys</option>';
    }
  }

  window.submitAddConnection = async function () {
    const label = document.getElementById('add-conn-label').value.trim();
    const host = document.getElementById('add-conn-host').value.trim();
    const username = document.getElementById('add-conn-username').value.trim();
    const port = parseInt(document.getElementById('add-conn-port').value) || 22;
    const keypairId = document.getElementById('add-conn-keypair').value;
    const errorEl = document.getElementById('add-conn-error');

    errorEl.hidden = true;

    if (!label || !host || !username) {
      errorEl.textContent = 'Please fill in all required fields.';
      errorEl.hidden = false;
      return;
    }

    const body = { label, host, username, port };
    if (keypairId) body.keypair_id = keypairId;

    try {
      const data = await api('POST', '/api/v1/connections', body);
      if (!data) return;

      closeSheet();
      showToast('Connection added!', 'success');
      loadConnections();

      var keypair = state.keypairs.find(function (k) { return k.id === keypairId; });
      if (keypair) {
        setTimeout(function () { showInstallKeySheet(keypair, data.connection); }, 400);
      }
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // Edit Connection Sheet
  // ═══════════════════════════════════════════════════════════════════

  function showEditConnectionSheet(conn) {
    loadKeypairsForForm().then(function (options) {
      showSheet('Edit Connection',
        '<form id="form-edit-conn" onsubmit="return false">' +
          '<div class="form-group">' +
            '<label class="form-label">Label</label>' +
            '<input class="form-input" id="edit-conn-label" type="text" value="' + escapeHtml(conn.label) + '" required>' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">Host</label>' +
            '<input class="form-input" id="edit-conn-host" type="text" value="' + escapeHtml(conn.host) + '" required>' +
          '</div>' +
          '<div class="form-row">' +
            '<div class="form-group">' +
              '<label class="form-label">Username</label>' +
              '<input class="form-input" id="edit-conn-username" type="text" value="' + escapeHtml(conn.username) + '" required>' +
            '</div>' +
            '<div class="form-group" style="max-width:100px">' +
              '<label class="form-label">Port</label>' +
              '<input class="form-input" id="edit-conn-port" type="number" value="' + (conn.port || 22) + '" min="1" max="65535">' +
            '</div>' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">SSH Key</label>' +
            '<select class="form-select" id="edit-conn-keypair">' + options + '</select>' +
          '</div>' +
          '<div id="edit-conn-error" class="form-error" hidden></div>' +
          '<button class="btn btn-primary btn-block mt-16" onclick="submitEditConnection(\'' + conn.id + '\')">Save Changes</button>' +
        '</form>'
      );

      var kpSelect = document.getElementById('edit-conn-keypair');
      if (kpSelect && conn.keypair_id) kpSelect.value = conn.keypair_id;
    });
  }

  window.submitEditConnection = async function (connId) {
    const label = document.getElementById('edit-conn-label').value.trim();
    const host = document.getElementById('edit-conn-host').value.trim();
    const username = document.getElementById('edit-conn-username').value.trim();
    const port = parseInt(document.getElementById('edit-conn-port').value) || 22;
    const keypairId = document.getElementById('edit-conn-keypair').value;
    const errorEl = document.getElementById('edit-conn-error');

    errorEl.hidden = true;

    const body = { label, host, username, port };
    if (keypairId) body.keypair_id = keypairId;

    try {
      await api('PATCH', '/api/v1/connections/' + connId, body);
      closeSheet();
      showToast('Connection updated!', 'success');
      loadConnections();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // Install Key Sheet
  // ═══════════════════════════════════════════════════════════════════

  async function showInstallKeySheet(keypair, connection) {
    var command = '';
    try {
      const data = await api('GET', '/api/v1/keys/' + keypair.id + '/install-command');
      if (data) command = data.command;
    } catch (err) {
      command = "mkdir -p ~/.ssh && echo '" + keypair.public_key + "' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys";
    }

    showSheet('Install Key on Server',
      '<p class="text-muted mb-16" style="font-size:14px">Run this command on your server to authorize Clawdfather:</p>' +
      '<div class="command-box" id="install-command">' + escapeHtml(command) + '</div>' +
      '<button class="btn btn-secondary btn-block mb-16" onclick="copyInstallCommand()">📋 Copy Command</button>' +
      (connection ?
        '<button class="btn btn-primary btn-block mb-16" onclick="testConnection(\'' + connection.id + '\')">Test Connection</button>' : '') +
      '<button class="btn-text btn-block" onclick="closeSheet()">I\'ll do this later</button>'
    );
  }

  window.copyInstallCommand = function () {
    var el = document.getElementById('install-command');
    if (!el) return;
    navigator.clipboard.writeText(el.textContent).then(function () {
      showToast('Command copied to clipboard!', 'success');
    }).catch(function () {
      showToast('Failed to copy — tap the command to select it', 'warning');
    });
  };

  // ═══════════════════════════════════════════════════════════════════
  // Connection Detail Sheet
  // ═══════════════════════════════════════════════════════════════════

  function showConnectionDetail(conn) {
    var pillHtml = '';
    if (conn.last_test_result === 'ok') {
      pillHtml = '<span class="pill pill-success">✓ Tested</span>';
    } else if (conn.last_test_result === 'failed' || conn.last_test_result === 'timeout') {
      pillHtml = '<span class="pill pill-danger">⚠ Test failed</span>';
    } else {
      pillHtml = '<span class="pill pill-gray">Not tested</span>';
    }

    var startSessionBtn = '';
    if (conn.last_test_result === 'ok') {
      startSessionBtn = '<button class="btn btn-primary" onclick="startSession(\'' + conn.id + '\')">Start Session</button>';
    }

    showSheet(conn.label,
      '<div class="detail-row"><span class="detail-label">Host</span><span class="detail-value">' + escapeHtml(conn.host) + '</span></div>' +
      '<div class="detail-row"><span class="detail-label">Username</span><span class="detail-value">' + escapeHtml(conn.username) + '</span></div>' +
      '<div class="detail-row"><span class="detail-label">Port</span><span class="detail-value">' + (conn.port || 22) + '</span></div>' +
      '<div class="detail-row"><span class="detail-label">Status</span><span>' + pillHtml + '</span></div>' +
      (conn.host_key_fingerprint ?
        '<div class="detail-row"><span class="detail-label">Host Key</span><span class="detail-value">' + escapeHtml(conn.host_key_fingerprint.substring(0, 32)) + '...</span></div>' : '') +
      '<div class="detail-actions">' +
        '<button class="btn btn-secondary" onclick="testConnection(\'' + conn.id + '\')">Test Connection</button>' +
        startSessionBtn +
        '<button class="btn btn-secondary" onclick="showInstallForConnection(\'' + conn.id + '\')">Show Install Command</button>' +
      '</div>' +
      '<button class="detail-delete" onclick="confirmDeleteConnection({id:\'' + conn.id + '\',label:\'' + escapeHtml(conn.label).replace(/'/g, "\\'") + '\'})">Delete Connection</button>'
    );
  }

  window.showInstallForConnection = async function (connId) {
    var conn = state.connections.find(function (c) { return c.id === connId; });
    if (!conn) return;

    var keypair = state.keypairs.find(function (k) { return k.id === conn.keypair_id; });
    if (!keypair) {
      try {
        var keysData = await api('GET', '/api/v1/keys');
        state.keypairs = keysData.keypairs || [];
        keypair = state.keypairs.find(function (k) { return k.id === conn.keypair_id; });
      } catch (err) { /* fall through */ }
    }

    if (keypair) {
      closeSheet();
      setTimeout(function () { showInstallKeySheet(keypair, conn); }, 350);
    } else {
      showToast('Could not find the keypair for this connection', 'error');
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // Test Connection
  // ═══════════════════════════════════════════════════════════════════

  window.testConnection = async function (connId) {
    closeSheet();
    await new Promise(function (r) { setTimeout(r, 350); });

    showSheet('Testing Connection',
      '<div class="test-result">' +
        '<div class="spinner"></div>' +
        '<div class="test-result-title">Testing connection...</div>' +
      '</div>'
    );

    try {
      var data = await api('POST', '/api/v1/connections/' + connId + '/test', { accept_host_key: false });
      if (!data) return;

      if (data.result === 'ok') {
        document.getElementById('sheet-content').innerHTML =
          '<div class="test-result">' +
            '<div class="test-result-icon">✅</div>' +
            '<div class="test-result-title" style="color:var(--success)">Connected in ' + (data.latency_ms || '?') + 'ms</div>' +
            (data.host_key_fingerprint ? '<div class="test-result-detail">' + escapeHtml(data.host_key_fingerprint) + '</div>' : '') +
          '</div>' +
          '<button class="btn btn-primary btn-block mt-16" onclick="closeSheet(); loadConnections();">Done</button>';
        loadConnections();
      } else if (data.result === 'host_key_changed') {
        document.getElementById('sheet-content').innerHTML =
          '<div class="host-key-warning">' +
            '<div class="host-key-warning-title">⚠️ Server Identity Changed</div>' +
            '<div class="host-key-warning-text">The server\'s host key has changed. This could indicate a server reinstall or a potential security issue.</div>' +
            '<div class="host-key-fingerprints">' +
              '<div class="host-key-fp-row"><span class="host-key-fp-label">Old:</span><span class="host-key-fp-value">' + escapeHtml(data.old_fingerprint || '?') + '</span></div>' +
              '<div class="host-key-fp-row"><span class="host-key-fp-label">New:</span><span class="host-key-fp-value">' + escapeHtml(data.new_fingerprint || '?') + '</span></div>' +
            '</div>' +
            '<div class="host-key-actions">' +
              '<button class="btn btn-primary" onclick="acceptHostKey(\'' + connId + '\')">Accept New Key</button>' +
              '<button class="btn btn-secondary" onclick="closeSheet()">Cancel</button>' +
            '</div>' +
          '</div>';
      } else {
        document.getElementById('sheet-content').innerHTML =
          '<div class="test-result">' +
            '<div class="test-result-icon">❌</div>' +
            '<div class="test-result-title" style="color:var(--danger)">Connection Failed</div>' +
            '<div class="test-result-detail" style="color:var(--text-secondary)">' + escapeHtml(data.message || 'Unknown error') + '</div>' +
          '</div>' +
          '<button class="btn btn-secondary btn-block mt-16" onclick="testConnection(\'' + connId + '\')">Retry</button>' +
          '<button class="btn-text btn-block" onclick="closeSheet()">Close</button>';
        loadConnections();
      }
    } catch (err) {
      document.getElementById('sheet-content').innerHTML =
        '<div class="test-result">' +
          '<div class="test-result-icon">❌</div>' +
          '<div class="test-result-title" style="color:var(--danger)">Test Failed</div>' +
          '<div class="test-result-detail" style="color:var(--text-secondary)">' + escapeHtml(err.message) + '</div>' +
        '</div>' +
        '<button class="btn btn-secondary btn-block mt-16" onclick="testConnection(\'' + connId + '\')">Retry</button>';
    }
  };

  window.acceptHostKey = async function (connId) {
    try {
      var data = await api('POST', '/api/v1/connections/' + connId + '/test', { accept_host_key: true });
      if (data && data.result === 'ok') {
        showToast('Host key accepted and connection successful!', 'success');
        closeSheet();
        loadConnections();
      } else {
        showToast('Failed to accept host key', 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // Delete Connection
  // ═══════════════════════════════════════════════════════════════════

  window.confirmDeleteConnection = function (conn) {
    closeSheet();
    setTimeout(function () {
      showSheet('Delete Connection',
        '<p class="confirm-text">Remove <strong>' + escapeHtml(conn.label) + '</strong>? This will delete the saved connection. The SSH key on the server will not be automatically removed.</p>' +
        '<div class="confirm-actions">' +
          '<button class="btn btn-secondary" onclick="closeSheet()">Cancel</button>' +
          '<button class="btn btn-danger-text" onclick="deleteConnection(\'' + conn.id + '\')">Delete</button>' +
        '</div>'
      );
    }, 350);
  };

  window.deleteConnection = async function (connId) {
    try {
      await api('DELETE', '/api/v1/connections/' + connId);
      closeSheet();
      showToast('Connection removed', 'success');
      loadConnections();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // Sessions
  // ═══════════════════════════════════════════════════════════════════

  async function loadSessions() {
    var loadingEl = document.getElementById('sessions-loading');
    var emptyEl = document.getElementById('sessions-empty');
    var listEl = document.getElementById('sessions-list');

    loadingEl.hidden = false;
    emptyEl.hidden = true;
    listEl.hidden = true;

    try {
      var data = await api('GET', '/api/v1/sessions');
      if (!data) return;

      state.sessions = data.sessions || [];
      loadingEl.hidden = true;

      if (state.sessions.length === 0) {
        emptyEl.hidden = false;
      } else {
        listEl.hidden = false;
        renderSessions();
      }
    } catch (err) {
      loadingEl.hidden = true;
      showToast('Failed to load sessions: ' + err.message, 'error');
    }
  }

  function renderSessions() {
    var listEl = document.getElementById('sessions-list');
    listEl.innerHTML = '';

    state.sessions.forEach(function (sess) {
      var card = document.createElement('div');
      card.className = 'session-card';

      var isActive = sess.status === 'active';
      var pillClass = isActive ? 'pill-active' : 'pill-gray';
      var pillText = isActive ? '● Active' : sess.status;

      var connLabel = (sess.connection && sess.connection.label) || 'Unknown';
      var connHost = (sess.connection && sess.connection.host) || '';

      var endBtnHtml = '';
      if (isActive) {
        endBtnHtml = '<button class="btn btn-danger-sm" onclick="event.stopPropagation(); endSession(\'' + sess.id + '\')">End Session</button>';
      }

      card.innerHTML =
        '<div class="session-card-header">' +
          '<span class="session-card-label">' + escapeHtml(connLabel) + '</span>' +
          '<span class="pill ' + pillClass + '">' + pillText + '</span>' +
        '</div>' +
        '<div class="session-card-host">' + escapeHtml(connHost) + '</div>' +
        '<div class="session-card-footer">' +
          '<span class="card-time">' + (sess.started_at ? formatRelativeTime(sess.started_at) : '') + '</span>' +
          endBtnHtml +
        '</div>';

      if (isActive) {
        card.onclick = function () { openChat(sess); };
      }

      listEl.appendChild(card);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Start Session
  // ═══════════════════════════════════════════════════════════════════

  window.startSession = async function (connectionId) {
    closeSheet();
    showToast('Starting session...', 'info');

    try {
      var data = await api('POST', '/api/v1/sessions', { connection_id: connectionId });
      if (!data || !data.session) return;

      showToast('Session started!', 'success');
      openChat(data.session);
    } catch (err) {
      showToast('Failed to start session: ' + err.message, 'error');
    }
  };

  window.endSession = async function (sessionId) {
    try {
      await api('DELETE', '/api/v1/sessions/' + sessionId);
      showToast('Session ended', 'success');
      loadSessions();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // Chat View
  // ═══════════════════════════════════════════════════════════════════

  function openChat(session) {
    state.activeChatSession = session;

    var chatView = document.getElementById('view-chat');
    var bottomNav = document.getElementById('bottom-nav');

    document.getElementById('chat-connection-label').textContent =
      (session.connection && session.connection.label) || 'Session';

    document.getElementById('chat-messages').innerHTML = '';

    chatView.style.display = 'flex';
    bottomNav.hidden = true;

    state.chatStartedAt = session.started_at ? new Date(session.started_at) : new Date();
    startChatTimer();

    addChatMessage('system', 'Connecting to session...');
    connectChat(session.id);
  }

  window.exitChat = function () {
    disconnectChat();

    var chatView = document.getElementById('view-chat');
    var bottomNav = document.getElementById('bottom-nav');

    chatView.style.display = 'none';
    bottomNav.hidden = false;

    state.activeChatSession = null;

    if (state.activeView === 'sessions') loadSessions();
  };

  window.endCurrentSession = function () {
    if (!state.activeChatSession) return;

    showSheet('End Session?',
      '<p class="confirm-text">End this session? The SSH connection will be closed.</p>' +
      '<div class="confirm-actions">' +
        '<button class="btn btn-secondary" onclick="closeSheet()">Cancel</button>' +
        '<button class="btn btn-danger-text" onclick="confirmEndSession()">End Session</button>' +
      '</div>'
    );
  };

  window.confirmEndSession = async function () {
    if (!state.activeChatSession) return;
    var sessId = state.activeChatSession.id;
    closeSheet();

    try {
      await api('DELETE', '/api/v1/sessions/' + sessId);
      showToast('Session ended', 'success');
      exitChat();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  function startChatTimer() {
    if (state.chatTimer) clearInterval(state.chatTimer);
    updateChatTimer();
    state.chatTimer = setInterval(updateChatTimer, 1000);
  }

  function updateChatTimer() {
    if (!state.chatStartedAt) return;
    var elapsed = Math.floor((Date.now() - state.chatStartedAt.getTime()) / 1000);
    var h = Math.floor(elapsed / 3600);
    var m = Math.floor((elapsed % 3600) / 60);
    var s = elapsed % 60;

    var timerEl = document.getElementById('chat-timer');
    if (timerEl) {
      timerEl.textContent = (h > 0 ? h + ':' : '') +
        (m < 10 ? '0' : '') + m + ':' +
        (s < 10 ? '0' : '') + s;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Chat WebSocket
  // ═══════════════════════════════════════════════════════════════════

  var chatHeartbeatInterval = null;
  var chatReconnectTimer = null;
  var chatReconnectDelay = 1000;
  var chatAuthenticated = false;

  function connectChat(sessionId) {
    disconnectChat();

    var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var host = window.location.host;
    var wsUrl = proto + '//' + host + '/ws/sessions/' + sessionId;

    var ws = new WebSocket(wsUrl);
    state.chatWs = ws;

    ws.onopen = function () {
      ws.send(JSON.stringify({ type: 'auth', token: state.token }));

      chatHeartbeatInterval = setInterval(function () {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'heartbeat' }));
        }
      }, 30000);
    };

    ws.onmessage = function (event) {
      try {
        var msg = JSON.parse(event.data);
        handleChatMessage(msg);
      } catch (e) {
        console.error('Failed to parse WS message:', e);
      }
    };

    ws.onclose = function (event) {
      chatAuthenticated = false;
      clearInterval(chatHeartbeatInterval);
      chatHeartbeatInterval = null;

      if (event.code === 4001) {
        addChatMessage('system', 'Session has ended.');
      } else if (state.activeChatSession && state.activeChatSession.id === sessionId) {
        addChatMessage('system', 'Connection lost. Reconnecting...');
        scheduleChatReconnect(sessionId);
      }
    };

    ws.onerror = function () {};
  }

  function scheduleChatReconnect(sessionId) {
    if (chatReconnectTimer) return;
    chatReconnectTimer = setTimeout(function () {
      chatReconnectTimer = null;
      chatReconnectDelay = Math.min(chatReconnectDelay * 2, 30000);
      if (state.activeChatSession && state.activeChatSession.id === sessionId) {
        connectChat(sessionId);
      }
    }, chatReconnectDelay);
  }

  function disconnectChat() {
    if (state.chatWs) {
      state.chatWs.onclose = null;
      state.chatWs.close();
      state.chatWs = null;
    }
    if (chatHeartbeatInterval) {
      clearInterval(chatHeartbeatInterval);
      chatHeartbeatInterval = null;
    }
    if (chatReconnectTimer) {
      clearTimeout(chatReconnectTimer);
      chatReconnectTimer = null;
    }
    if (state.chatTimer) {
      clearInterval(state.chatTimer);
      state.chatTimer = null;
    }
    chatReconnectDelay = 1000;
    chatAuthenticated = false;
  }

  function handleChatMessage(msg) {
    switch (msg.type) {
      case 'session':
        chatAuthenticated = true;
        chatReconnectDelay = 1000;
        removeChatThinking();
        addChatMessage('system', 'Connected to ' +
          (msg.connection ? msg.connection.label + ' (' + msg.connection.host + ')' : 'session'));
        break;

      case 'message':
        removeChatThinking();
        if (msg.role === 'assistant') {
          addChatMessage('assistant', msg.text || '');
        }
        break;

      case 'status':
        if (msg.status === 'thinking') {
          showChatThinking();
        } else if (msg.status === 'done') {
          removeChatThinking();
        }
        break;

      case 'heartbeat_ack':
        break;

      case 'error':
        removeChatThinking();
        addChatMessage('system', 'Error: ' + (msg.message || 'Unknown error'));
        break;

      case 'session_closed':
        removeChatThinking();
        addChatMessage('system', msg.message || 'Session closed: ' + (msg.reason || 'unknown'));
        break;
    }
  }

  function addChatMessage(role, text) {
    var container = document.getElementById('chat-messages');
    var div = document.createElement('div');
    div.className = 'chat-msg ' + role;

    var senderName = role === 'user' ? 'You' : role === 'assistant' ? '🦞 Clawdfather' : 'System';
    var time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    div.innerHTML =
      '<div class="chat-msg-header">' +
        '<span class="chat-msg-sender ' + role + '">' + senderName + '</span>' +
        '<span class="chat-msg-time">' + time + '</span>' +
      '</div>' +
      '<div class="chat-msg-body">' + renderMarkdown(text) + '</div>';

    container.appendChild(div);
    scrollChatToBottom();
  }

  function showChatThinking() {
    if (document.getElementById('chat-thinking')) return;
    var container = document.getElementById('chat-messages');
    var div = document.createElement('div');
    div.className = 'chat-thinking';
    div.id = 'chat-thinking';
    div.innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span></div> Thinking...';
    container.appendChild(div);
    scrollChatToBottom();
  }

  function removeChatThinking() {
    var el = document.getElementById('chat-thinking');
    if (el) el.remove();
  }

  function scrollChatToBottom() {
    var container = document.getElementById('chat-messages');
    requestAnimationFrame(function () {
      container.scrollTop = container.scrollHeight;
    });
  }

  window.sendChatMessage = function () {
    var input = document.getElementById('chat-input');
    var text = input.value.trim();
    if (!text || !chatAuthenticated || !state.chatWs) return;

    addChatMessage('user', text);
    state.chatWs.send(JSON.stringify({ type: 'message', text: text }));
    input.value = '';
    input.style.height = 'auto';
  };

  // Chat input: Enter to send, Shift+Enter for newline
  document.addEventListener('DOMContentLoaded', function () {
    var chatInput = document.getElementById('chat-input');
    if (chatInput) {
      chatInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendChatMessage();
        }
      });
      chatInput.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 120) + 'px';
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Settings
  // ═══════════════════════════════════════════════════════════════════

  async function loadSettings() {
    updateAccountUI();
    loadKeypairs();
    loadVersion();
  }

  async function loadKeypairs() {
    var listEl = document.getElementById('keys-list');
    listEl.innerHTML = '<div class="loading-state" style="min-height:100px;padding:20px"><div class="spinner"></div></div>';

    try {
      var data = await api('GET', '/api/v1/keys');
      if (!data) return;

      state.keypairs = data.keypairs || [];

      if (state.keypairs.length === 0) {
        listEl.innerHTML = '<p class="text-muted text-center" style="padding:20px;font-size:14px">No keys generated yet.</p>';
        return;
      }

      listEl.innerHTML = '';
      state.keypairs.forEach(function (key) {
        var item = document.createElement('div');
        item.className = 'key-item';
        item.onclick = function () { showKeyDetail(key); };

        var statusPill = key.is_active ?
          '<span class="pill pill-success">Active</span>' :
          '<span class="pill pill-gray">Revoked</span>';

        item.innerHTML =
          '<div class="key-item-header">' +
            '<span class="key-item-label">' + escapeHtml(key.label) + '</span>' +
            statusPill +
          '</div>' +
          '<div class="key-item-fingerprint">' + escapeHtml(key.fingerprint) + '</div>';

        listEl.appendChild(item);
      });
    } catch (err) {
      listEl.innerHTML = '<p class="text-danger text-center" style="padding:20px;font-size:14px">Failed to load keys</p>';
    }
  }

  function showKeyDetail(key) {
    var revokeHtml = key.is_active ?
      '<button class="detail-delete" onclick="revokeKey(\'' + key.id + '\')">Revoke Key</button>' : '';

    showSheet(key.label,
      '<div class="detail-row"><span class="detail-label">Algorithm</span><span class="detail-value">' + escapeHtml(key.algorithm || 'ed25519') + '</span></div>' +
      '<div class="detail-row"><span class="detail-label">Status</span><span>' +
        (key.is_active ? '<span class="pill pill-success">Active</span>' : '<span class="pill pill-gray">Revoked</span>') +
      '</span></div>' +
      '<div class="detail-row" style="flex-direction:column;align-items:flex-start;gap:4px">' +
        '<span class="detail-label">Fingerprint</span>' +
        '<span class="detail-value" style="max-width:100%;font-size:12px">' + escapeHtml(key.fingerprint) + '</span>' +
      '</div>' +
      (key.public_key ?
        '<div style="margin-top:16px">' +
          '<span class="detail-label" style="display:block;margin-bottom:6px">Public Key</span>' +
          '<div class="command-box" style="font-size:11px">' + escapeHtml(key.public_key) + '</div>' +
          '<button class="btn btn-secondary btn-block" onclick="copyText(\'' + escapeHtml(key.public_key).replace(/'/g, "\\'") + '\')">📋 Copy Public Key</button>' +
        '</div>' : '') +
      revokeHtml
    );
  }

  window.copyText = function (text) {
    navigator.clipboard.writeText(text).then(function () {
      showToast('Copied to clipboard!', 'success');
    }).catch(function () {
      showToast('Failed to copy', 'warning');
    });
  };

  window.revokeKey = async function (keyId) {
    closeSheet();
    await new Promise(function (r) { setTimeout(r, 350); });

    showSheet('Revoke Key?',
      '<p class="confirm-text">Revoke this key? Active sessions using it will be terminated. You\'ll need to generate a new key and install it on your servers.</p>' +
      '<div class="confirm-actions">' +
        '<button class="btn btn-secondary" onclick="closeSheet()">Cancel</button>' +
        '<button class="btn btn-danger-text" onclick="confirmRevokeKey(\'' + keyId + '\')">Revoke</button>' +
      '</div>'
    );
  };

  window.confirmRevokeKey = async function (keyId) {
    try {
      await api('DELETE', '/api/v1/keys/' + keyId);
      closeSheet();
      showToast('Key revoked', 'success');
      loadKeypairs();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  document.addEventListener('DOMContentLoaded', function () {
    var genKeyBtn = document.getElementById('btn-generate-key');
    if (genKeyBtn) {
      genKeyBtn.onclick = async function () {
        showSheet('Generate New Key',
          '<form onsubmit="return false">' +
            '<div class="form-group">' +
              '<label class="form-label">Key Label</label>' +
              '<input class="form-input" id="new-key-label" type="text" placeholder="e.g. mobile-key" value="default" autocomplete="off">' +
            '</div>' +
            '<div id="gen-key-error" class="form-error" hidden></div>' +
            '<button class="btn btn-primary btn-block mt-16" onclick="submitGenerateKey()">Generate Key</button>' +
          '</form>'
        );
      };
    }
  });

  window.submitGenerateKey = async function () {
    var label = document.getElementById('new-key-label').value.trim() || 'default';
    var errorEl = document.getElementById('gen-key-error');
    errorEl.hidden = true;

    try {
      var data = await api('POST', '/api/v1/keys', { label: label });
      if (!data) return;
      closeSheet();
      showToast('Key generated!', 'success');
      loadKeypairs();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  };

  async function loadVersion() {
    try {
      var res = await fetch('/api/version');
      var data = await res.json();
      var el = document.getElementById('settings-version');
      if (el) el.textContent = 'v' + data.version + (data.commit ? ' (' + data.commit + ')' : '');
    } catch (e) {
      /* ignore */
    }
  }

  // Sign out button
  document.addEventListener('DOMContentLoaded', function () {
    var signOutBtn = document.getElementById('btn-sign-out');
    if (signOutBtn) signOutBtn.onclick = logout;
  });

  // ═══════════════════════════════════════════════════════════════════
  // Simple Markdown Renderer
  // ═══════════════════════════════════════════════════════════════════

  function renderMarkdown(text) {
    if (!text) return '';

    var html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
      return '<pre><code class="language-' + (lang || 'text') + '">' + code.trim() + '</code></pre>';
    });

    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    html = html.replace(/\n/g, '<br>');

    html = html.replace(/<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g, function (match) {
      return match.replace(/<br>/g, '\n');
    });

    return html;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Utilities
  // ═══════════════════════════════════════════════════════════════════

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatRelativeTime(isoStr) {
    if (!isoStr) return '';
    var date = new Date(isoStr);
    var now = new Date();
    var diffSec = Math.floor((now - date) / 1000);

    if (diffSec < 60) return 'just now';
    if (diffSec < 3600) return Math.floor(diffSec / 60) + 'm ago';
    if (diffSec < 86400) return Math.floor(diffSec / 3600) + 'h ago';
    if (diffSec < 604800) return Math.floor(diffSec / 86400) + 'd ago';
    return date.toLocaleDateString();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Initialization
  // ═══════════════════════════════════════════════════════════════════

  async function init() {
    // Check for OAuth callback params first
    var oauthSuccess = await handleOAuthCallback();
    if (oauthSuccess) {
      showAppShell();
      loadAccount();
      return;
    }

    // Check if we have a stored token
    if (state.token) {
      try {
        var data = await api('GET', '/api/v1/auth/me');
        if (data && data.account) {
          state.account = data.account;
          showAppShell();
          updateAccountUI();
          return;
        }
      } catch (err) {
        // Token invalid, clear and show auth
        state.token = null;
        localStorage.removeItem('clf_token');
      }
    }

    showAuthScreen();
  }

  // GitHub login button
  document.addEventListener('DOMContentLoaded', function () {
    var loginBtn = document.getElementById('btn-github-login');
    if (loginBtn) loginBtn.onclick = startOAuth;
  });

  // Start the app
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
