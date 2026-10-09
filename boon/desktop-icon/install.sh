#!/bin/bash
# Sets up BOON's floating desktop icon on this Mac. Like boon/focus-helper, this doesn't run in place from the
# Desktop checkout — macOS guards Desktop/Documents from processes launchd starts — so it copies itself to
# ~/Library/Application Support/BOON Icon and runs from there, pointed back at this checkout's boon/ folder so it
# always serves the current code. Re-run after any change to this folder to refresh the copy.
#   ./install.sh               set it up (or re-apply after a code change: copy, re-register, start)
#   ./install.sh --uninstall   stop it, remove the LaunchAgent and the copied app
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
boon_dir="$(cd "$here/.." && pwd -P)"
app="$HOME/Library/Application Support/BOON Icon"
label="com.boon.icon"
plist="$HOME/Library/LaunchAgents/$label.plist"
log="$HOME/Library/Logs/boon-icon.log"

stop_if_loaded() {
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || launchctl unload "$plist" 2>/dev/null || true
}

if [ "${1:-}" = "--uninstall" ]; then
  stop_if_loaded
  rm -f "$plist"
  rm -rf "$app"
  echo "BOON desktop icon removed."
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed. Install it first (e.g. from nodejs.org, or 'brew install node'), then run this again." >&2
  exit 1
fi

mkdir -p "$app"
for f in main.js preload.js icon.html open-boon.js package.json package-lock.json; do
  cp "$here/$f" "$app/.$f.new"
  mv -f "$app/.$f.new" "$app/$f"
done
printf '%s' "$boon_dir" >"$app/boon-dir.txt"

cd "$app"
if [ ! -d node_modules/electron ]; then
  echo "Installing dependencies (downloads Electron, ~150 MB — one time only)..."
  npm install
fi
electron_bin="$app/node_modules/.bin/electron"
# npm can skip electron's postinstall (its "download the real binary" step) depending on script-safety settings,
# leaving just a stub that would otherwise try to download it lazily on first launch — unattended, under launchd,
# where a failure has nowhere to show up. Force that now, while we're still interactive and can see it fail.
echo "Checking Electron is fully downloaded..."
"$electron_bin" --version >/dev/null || { echo "Electron didn't install correctly." >&2; exit 1; }

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
    <string>$app</string>
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
