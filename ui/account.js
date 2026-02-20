/**
 * Clawdfather Account Management UI
 */
(function () {
  "use strict";

  // ── DOM Elements ──────────────────────────────────────────────────
  var $loading = document.getElementById("loading-state");
  var $error = document.getElementById("error-state");
  var $view = document.getElementById("account-view");
  var $balanceDisplay = document.getElementById("balance-display");
  var $accountId = document.getElementById("account-id");
  var $keyCount = document.getElementById("key-count");
  var $keyList = document.getElementById("key-list");
  var $inputFingerprint = document.getElementById("input-fingerprint");
  var $inputLabel = document.getElementById("input-label");
  var $btnAddKey = document.getElementById("btn-add-key");
  var $addKeyError = document.getElementById("add-key-error");
  var $hourSelect = document.getElementById("hour-select");
  var $priceDisplay = document.getElementById("price-display");
  var $btnCheckout = document.getElementById("btn-checkout");
  var $checkoutError = document.getElementById("checkout-error");

  // ── State ─────────────────────────────────────────────────────────
  var token = null;
  var account = null;
  var tokenExpiresAt = null;
  var refreshTimer = null;
  var TOKEN_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

  // ── Token extraction ──────────────────────────────────────────────
  function extractToken() {
    var hash = window.location.hash.slice(1);
    if (!hash) return null;
    var params = new URLSearchParams(hash);
    return params.get("token") || params.get("account") || null;
  }

  // ── Format balance ────────────────────────────────────────────────
  function formatBalance(seconds) {
    if (seconds <= 0) return "0 min (no credits)";
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return h + " hr " + m + " min";
    return m + " min";
  }

  // ── API helpers ───────────────────────────────────────────────────
  function apiHeaders() {
    return {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token,
    };
  }

  function fetchAccount() {
    return fetch("/api/account/me", {
      method: "GET",
      headers: apiHeaders(),
    }).then(function (r) {
      if (r.status === 401) throw new Error("UNAUTHORIZED");
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function addKey(fingerprint, label) {
    var body = { fingerprint: fingerprint };
    if (label) body.label = label;
    return fetch("/api/account/keys/add", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data.error || "Failed to add key");
        return data;
      });
    });
  }

  function removeKey(keyId) {
    return fetch("/api/account/keys/" + keyId, {
      method: "DELETE",
      headers: apiHeaders(),
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data.error || "Failed to remove key");
        return data;
      });
    });
  }

  function purchaseTime(hours) {
    return fetch("/api/account/checkout", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ hours: hours }),
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data.error || "Failed to create checkout");
        return data;
      });
    });
  }

  // ── UI States ─────────────────────────────────────────────────────
  function showLoading() {
    $loading.style.display = "";
    $error.style.display = "none";
    $view.style.display = "none";
  }

  function showError(msg) {
    $loading.style.display = "none";
    $error.style.display = "";
    $error.textContent = msg;
    $view.style.display = "none";
  }

  function showAccount() {
    $loading.style.display = "none";
    $error.style.display = "none";
    $view.style.display = "";
  }

  // ── Render account data ───────────────────────────────────────────
  function render(data) {
    account = data;

    var bal = formatBalance(data.creditsSec);
    $balanceDisplay.textContent = "Balance: " + bal;
    $balanceDisplay.className = "balance-display" + (data.creditsSec <= 0 ? " empty" : "");

    $accountId.textContent = "Account ID: " + data.accountId.slice(0, 10) + "...";

    renderKeys(data.keys || []);
  }

  function renderKeys(keys) {
    $keyCount.textContent = keys.length;
    $keyList.innerHTML = "";

    if (keys.length === 0) {
      var empty = document.createElement("div");
      empty.className = "empty-keys";
      empty.textContent = "No SSH keys linked yet.";
      $keyList.appendChild(empty);
      return;
    }

    keys.forEach(function (key) {
      var li = document.createElement("li");
      li.className = "key-item";
      li.setAttribute("data-key-id", key.keyId);

      var info = document.createElement("div");
      info.className = "key-info";

      var fp = document.createElement("span");
      fp.className = "key-fingerprint";
      fp.textContent = key.fingerprint;

      info.appendChild(fp);

      if (key.label) {
        var label = document.createElement("span");
        label.className = "key-label";
        label.textContent = "[" + key.label + "]";
        info.appendChild(label);
      }

      var actions = document.createElement("div");

      var removeBtn = document.createElement("button");
      removeBtn.className = "btn-remove";
      removeBtn.textContent = "Remove";
      removeBtn.onclick = function () {
        showRemoveConfirm(li, key);
      };
      actions.appendChild(removeBtn);

      li.appendChild(info);
      li.appendChild(actions);
      $keyList.appendChild(li);
    });
  }

  function showRemoveConfirm(li, key) {
    var existing = li.querySelector(".confirm-row");
    if (existing) return;

    var actionsDiv = li.lastElementChild;
    actionsDiv.innerHTML = "";

    var row = document.createElement("div");
    row.className = "confirm-row";
    row.textContent = "Remove " + key.fingerprint.slice(0, 16) + "...? ";

    var yesBtn = document.createElement("button");
    yesBtn.className = "btn-confirm-yes";
    yesBtn.textContent = "Yes";
    yesBtn.onclick = function () {
      yesBtn.disabled = true;
      removeKey(key.keyId)
        .then(function () { return refreshAccount(); })
        .catch(function (err) {
          showFormError($addKeyError, err.message);
        });
    };

    var cancelBtn = document.createElement("button");
    cancelBtn.className = "btn-confirm-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.onclick = function () {
      refreshAccount();
    };

    row.appendChild(yesBtn);
    row.appendChild(cancelBtn);
    actionsDiv.appendChild(row);
  }

  // ── Add key ───────────────────────────────────────────────────────
  function handleAddKey() {
    hideFormError($addKeyError);
    var fp = $inputFingerprint.value.trim();
    var label = $inputLabel.value.trim();

    if (!fp) {
      showFormError($addKeyError, "Fingerprint is required.");
      return;
    }
    if (!fp.startsWith("SHA256:")) {
      showFormError($addKeyError, 'Fingerprint must start with "SHA256:"');
      return;
    }
    if (fp.length < 10) {
      showFormError($addKeyError, "Fingerprint appears too short.");
      return;
    }

    $btnAddKey.disabled = true;
    addKey(fp, label || undefined)
      .then(function () {
        $inputFingerprint.value = "";
        $inputLabel.value = "";
        return refreshAccount();
      })
      .catch(function (err) {
        showFormError($addKeyError, err.message);
      })
      .finally(function () {
        $btnAddKey.disabled = false;
      });
  }

  // ── Purchase ──────────────────────────────────────────────────────
  function updatePrice() {
    var hours = parseInt($hourSelect.value, 10) || 1;
    $priceDisplay.textContent = "$" + hours + ".00";
  }

  function handleCheckout() {
    hideFormError($checkoutError);
    var hours = parseInt($hourSelect.value, 10) || 1;
    $btnCheckout.disabled = true;
    $btnCheckout.textContent = "Redirecting...";

    purchaseTime(hours)
      .then(function (data) {
        if (data.checkoutUrl) {
          window.location.href = data.checkoutUrl;
        } else {
          throw new Error("No checkout URL returned");
        }
      })
      .catch(function (err) {
        showFormError($checkoutError, err.message);
        $btnCheckout.disabled = false;
        $btnCheckout.textContent = "Buy via Stripe →";
      });
  }

  // ── Form error helpers ────────────────────────────────────────────
  function showFormError(el, msg) {
    el.textContent = msg;
    el.style.display = "";
  }

  function hideFormError(el) {
    el.textContent = "";
    el.style.display = "none";
  }

  // ── Refresh ───────────────────────────────────────────────────────
  function refreshAccount() {
    return fetchAccount().then(function (data) {
      tokenExpiresAt = data.tokenExpiresAt || null;
      render(data);
    });
  }

  // ── Token refresh ────────────────────────────────────────────────
  function refreshToken() {
    return fetch("/api/account/token/refresh", {
      method: "POST",
      headers: apiHeaders(),
    }).then(function (r) {
      if (r.status === 401) throw new Error("UNAUTHORIZED");
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (data) {
      token = data.token;
      tokenExpiresAt = data.expiresAt || null;
    }).catch(function (err) {
      if (err.message === "UNAUTHORIZED") {
        stopTokenRefresh();
        showError("Session expired. Reconnect via SSH.");
      }
    });
  }

  function startTokenRefresh() {
    stopTokenRefresh();
    refreshTimer = setInterval(refreshToken, TOKEN_REFRESH_INTERVAL_MS);
  }

  function stopTokenRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  // ── Init ──────────────────────────────────────────────────────────
  function init() {
    token = extractToken();

    // Scrub token from URL
    if (window.location.hash) {
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      } else {
        window.location.hash = "";
      }
    }

    if (!token) {
      showError("No account token found. Connect via SSH first.");
      return;
    }

    showLoading();

    fetchAccount()
      .then(function (data) {
        tokenExpiresAt = data.tokenExpiresAt || null;
        render(data);
        showAccount();
        startTokenRefresh();
      })
      .catch(function (err) {
        if (err.message === "UNAUTHORIZED") {
          showError("Session expired. Reconnect via SSH.");
        } else {
          showError("Failed to load account: " + err.message);
        }
      });

    // Event listeners
    $btnAddKey.addEventListener("click", handleAddKey);
    $inputFingerprint.addEventListener("keydown", function (e) {
      if (e.key === "Enter") handleAddKey();
    });
    $hourSelect.addEventListener("change", updatePrice);
    $btnCheckout.addEventListener("click", handleCheckout);
  }

  init();
})();
