#!/usr/bin/env bash
set -euo pipefail

# Full diagnostic bundle for escalation: OS info, versions, service status,
# logs, config (REDACTED), disk, memory, ports. Safe to share with support.

usage() {
  echo "Usage: $0 openclaw@TARGET_HOST"
  echo ""
  echo "Example: $0 openclaw@1.2.3.4"
  exit 1
}

[[ $# -lt 1 ]] && usage

TARGET="$1"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)

ssh "${SSH_OPTS[@]}" "$TARGET" bash -s <<'REMOTE'
echo "======================================"
echo "OPENCLAW DIAGNOSTIC BUNDLE"
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Hostname:  $(hostname)"
echo "======================================"

echo ""
echo "--- OS Info ---"
uname -a
grep -E 'NAME|VERSION' /etc/os-release 2>/dev/null || echo "(unknown)"

echo ""
echo "--- Node.js / npm ---"
node --version 2>/dev/null || echo "node: not found"
npm --version 2>/dev/null || echo "npm: not found"

echo ""
echo "--- OpenClaw Version ---"
export PATH=$(npm prefix -g 2>/dev/null)/bin:$PATH
openclaw --version 2>/dev/null || echo "openclaw: not found"

echo ""
echo "--- Service Status ---"
systemctl --user status openclaw-gateway --no-pager 2>/dev/null || echo "(native service not found)"
echo ""
docker ps --filter name=openclaw 2>/dev/null || echo "(docker not available)"

echo ""
echo "--- Last 100 Log Lines ---"
journalctl --user -u openclaw-gateway -n 100 --no-pager 2>/dev/null || echo "(no journald logs)"
echo ""
docker logs openclaw-gateway --tail 100 2>/dev/null || echo "(no docker logs)"

echo ""
echo "--- Config (REDACTED) ---"
if [[ -f ~/.openclaw/openclaw.json ]]; then
  python3 -c "
import json, re, sys
with open('$HOME/.openclaw/openclaw.json') as f:
    raw = f.read()
redacted = re.sub(
    r'(\"(?:token|password|botToken|apiKey|secret)\"\s*:\s*\")([^\"]+)(\")',
    r'\1[REDACTED]\3',
    raw
)
print(redacted)
" 2>/dev/null || echo "(could not read config)"
else
  echo "openclaw.json: NOT FOUND"
fi

echo ""
echo "--- Disk ---"
df -h /

echo ""
echo "--- Memory ---"
free -h

echo ""
echo "--- Listening Ports ---"
ss -tlnp

echo ""
echo "======================================"
echo "END DIAGNOSTIC BUNDLE"
echo "======================================"
REMOTE
