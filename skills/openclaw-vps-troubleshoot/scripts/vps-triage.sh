#!/usr/bin/env bash
set -euo pipefail

# Quick diagnostic triage snapshot: service status, port check, disk, memory,
# recent error lines. Human-readable output for fast problem identification.

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
echo "========================================"
echo "OpenClaw Triage Report"
echo "Host:   $(hostname)"
echo "Date:   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Uptime: $(uptime -p 2>/dev/null || uptime)"
echo "========================================"
echo ""

echo "--- Native Service ---"
if systemctl --user is-active openclaw-gateway &>/dev/null; then
  echo "Status: $(systemctl --user is-active openclaw-gateway)"
else
  echo "Status: not running / not installed"
fi

echo ""
echo "--- Docker Container ---"
if command -v docker &>/dev/null; then
  docker inspect openclaw-gateway --format 'Status: {{.State.Status}}' 2>/dev/null || echo "Status: container not found"
else
  echo "Status: docker not installed"
fi

echo ""
echo "--- Port 18789 ---"
ss -tlnp | grep ':18789 ' || echo "NOT LISTENING"

echo ""
echo "--- Disk ---"
df -h / | tail -1

echo ""
echo "--- Memory ---"
free -h | grep -E 'Mem|Swap'

echo ""
echo "--- Last 10 Error Lines (journald) ---"
journalctl --user -u openclaw-gateway -n 100 --no-pager 2>/dev/null | grep -i 'error\|fail\|warn\|fatal\|panic' | tail -10 || echo "(no journald logs)"

echo ""
echo "--- Last 10 Error Lines (docker) ---"
if command -v docker &>/dev/null; then
  docker logs openclaw-gateway --tail 100 2>/dev/null | grep -i 'error\|fail\|warn\|fatal\|panic' | tail -10 || echo "(no docker logs)"
else
  echo "(docker not installed)"
fi

echo ""
echo "========================================"
echo "END TRIAGE"
echo "========================================"
REMOTE
