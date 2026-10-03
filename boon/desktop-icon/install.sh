#!/bin/bash
# Sets up BOON's floating desktop icon on this Mac: installs its dependencies (first run only — downloads
# Electron, ~150 MB), then registers it as a per-user LaunchAgent so it starts at login and stays running across
# restarts, and starts it right now so there's no need to log out and back in to see it.
#   ./install.sh               set it up (or re-apply after a code change: stop, re-register, start)
#   ./install.sh --uninstall   stop it and remove the LaunchAgent (the files themselves are untouched)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
label="com.boon.icon"
plist="$HOME/Library/LaunchAgents/$label.plist"
log="$HOME/Library/Logs/boon-icon.log"

stop_if_loaded() {
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || launchctl unload "$plist" 2>/dev/null || true
}

if [ "${1:-}" = "--uninstall" ]; then
  stop_if_loaded
  rm -f "$plist"
  echo "BOON desktop icon removed."
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed. Install it first (e.g. from nodejs.org, or 'brew install node'), then run this again." >&2
  exit 1
fi

cd "$here"
if [ ! -d node_modules/electron ]; then
  echo "Installing dependencies (downloads Electron, ~150 MB — one time only)..."
  npm install
fi
electron_bin="$here/node_modules/.bin/electron"
[ -x "$electron_bin" ] || { echo "Electron didn't install correctly." >&2; exit 1; }

stop_if_loaded
cat >"$plist.new" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$electron_bin</string>
    <string>$here</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
EOF
mv -f "$plist.new" "$plist"
launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load "$plist"
launchctl kickstart -k "gui/$(id -u)/$label" 2>/dev/null || true

echo "BOON desktop icon installed — it should appear on screen now, and again every time you log in."
echo "Log: $log"
