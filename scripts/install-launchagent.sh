#!/usr/bin/env bash
# Install (or reinstall) the A2A daemon as a user LaunchAgent.
#
# Idempotent: an existing agent is booted out first, and an existing token is
# reused rather than regenerated — a new token would lock out every client that
# already has the old one.
#
#   scripts/install-launchagent.sh              # install / reinstall
#   scripts/install-launchagent.sh --uninstall  # remove it
set -euo pipefail

LABEL="io.mgcrea.mcp-a2a"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOMAIN="gui/$(id -u)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

if [[ ! -f "$ROOT/dist/serve.js" ]]; then
  echo "dist/serve.js is missing — run 'pnpm build' first." >&2
  exit 1
fi

# Reuse the token already installed, so reinstalling does not lock out clients.
TOKEN="${A2A_TOKEN:-}"
if [[ -z "$TOKEN" && -f "$PLIST" ]]; then
  TOKEN="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:A2A_TOKEN' "$PLIST" 2>/dev/null || true)"
fi
if [[ -z "$TOKEN" ]]; then
  TOKEN="$(openssl rand -hex 32)"
  echo "generated a new A2A_TOKEN — give this same value to every client:"
  echo "  $TOKEN"
fi

mkdir -p "$HOME/Library/LaunchAgents"
# `|` as the sed delimiter: every replacement here is a path.
sed -e "s|__NODE__|$(command -v node)|" \
    -e "s|__DIST__|$ROOT/dist/serve.js|" \
    -e "s|__TOKEN__|$TOKEN|" \
    "$ROOT/launchd/$LABEL.plist.example" > "$PLIST"
chmod 600 "$PLIST"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"

echo "installed $LABEL"
echo "  plist:  $PLIST"
echo "  log:    tail -f /tmp/mcp-a2a-serve.log"
echo "  health: curl -s http://127.0.0.1:41241/health"
