#!/usr/bin/env bash
set -euo pipefail

# Run a full health check against an OpenClaw VPS: service status, health endpoint,
# port exposure, file permissions, openclaw doctor. Prints PASS/FAIL summary.

usage() {
  echo "Usage: $0 openclaw@TARGET_HOST GATEWAY_TOKEN"
  echo ""
  echo "Example: $0 openclaw@1.2.3.4 abc123..."
  exit 1
}

[[ $# -lt 2 ]] && usage

TARGET="$1"
TOKEN="$2"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)

PASS=0
FAIL=0

result() {
  local label="$1" status="$2"
  if [[ "$status" == "PASS" ]]; then
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label"
    FAIL=$((FAIL + 1))
  fi
}

echo "========================================"
echo "OpenClaw Health Check"
echo "Target: $TARGET"
echo "Date:   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "========================================"
echo ""

# Detect variant (native vs docker)
VARIANT=$(ssh "${SSH_OPTS[@]}" "$TARGET" bash -s <<'REMOTE'
if systemctl --user is-active openclaw-gateway &>/dev/null; then
  echo "native"
elif docker inspect openclaw-gateway &>/dev/null 2>&1; then
  echo "docker"
else
  echo "unknown"
fi
REMOTE
)
echo "Detected variant: $VARIANT"
echo ""

# Check 1: Service status
SVC_STATUS=$(ssh "${SSH_OPTS[@]}" "$TARGET" bash -s -- "$VARIANT" <<'REMOTE'
VARIANT="$1"
if [[ "$VARIANT" == "native" ]]; then
  systemctl --user is-active openclaw-gateway 2>/dev/null || echo "inactive"
elif [[ "$VARIANT" == "docker" ]]; then
  docker inspect openclaw-gateway --format '{{.State.Status}}' 2>/dev/null || echo "not found"
else
  echo "unknown"
fi
REMOTE
)
if [[ "$SVC_STATUS" == "active" ]] || [[ "$SVC_STATUS" == "running" ]]; then
  result "Service status ($SVC_STATUS)" "PASS"
else
  result "Service status ($SVC_STATUS)" "FAIL"
fi

# Check 2: Health endpoint
HEALTH=$(ssh "${SSH_OPTS[@]}" "$TARGET" bash -s -- "$TOKEN" <<'REMOTE'
TOKEN="$1"
curl -sf -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18789/health >/dev/null 2>&1 && echo "ok" || echo "fail"
REMOTE
)
result "Health endpoint (/health)" "$([ "$HEALTH" = "ok" ] && echo PASS || echo FAIL)"

# Check 3: Port binding (loopback only)
PORT_CHECK=$(ssh "${SSH_OPTS[@]}" "$TARGET" bash -s <<'REMOTE'
if ss -tlnp | grep ':18789 ' | grep -qv '127.0.0.1'; then
  echo "exposed"
else
  echo "loopback"
fi
REMOTE
)
result "Port 18789 loopback-only" "$([ "$PORT_CHECK" = "loopback" ] && echo PASS || echo FAIL)"

# Check 4: File permissions
PERMS=$(ssh "${SSH_OPTS[@]}" "$TARGET" bash -s <<'REMOTE'
dir_mode=$(stat -c '%a' ~/.openclaw 2>/dev/null || echo "000")
conf_mode=$(stat -c '%a' ~/.openclaw/openclaw.json 2>/dev/null || echo "000")
[[ "$dir_mode" == "700" ]] && [[ "$conf_mode" == "600" ]] && echo "ok" || echo "bad dir=$dir_mode conf=$conf_mode"
REMOTE
)
result "File permissions (.openclaw=700, json=600)" "$(echo "$PERMS" | grep -q "^ok" && echo PASS || echo FAIL)"

# Check 5: openclaw doctor
DOC=$(ssh "${SSH_OPTS[@]}" "$TARGET" bash -s <<'REMOTE'
export PATH=$(npm prefix -g 2>/dev/null)/bin:$PATH
if command -v openclaw &>/dev/null; then
  openclaw doctor >/dev/null 2>&1 && echo "ok" || echo "issues"
else
  echo "not installed"
fi
REMOTE
)
result "openclaw doctor" "$([ "$DOC" = "ok" ] && echo PASS || echo FAIL)"

echo ""
echo "========================================"
echo "RESULTS: $PASS PASS | $FAIL FAIL"
if [[ $FAIL -eq 0 ]]; then
  echo "STATUS:  ALL CHECKS PASSED"
else
  echo "STATUS:  $FAIL CHECK(S) FAILED"
fi
echo "========================================"
