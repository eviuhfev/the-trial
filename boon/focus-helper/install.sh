#!/bin/bash
# Sets up the BOON Focus helper for Chrome on this Mac: copies it to ~/Library/Application Support/BOON Focus (macOS
# guards the Desktop and Documents folders, so it can't run from there), then tells Chrome where it is and that only
# the BOON Focus add-on in boon/extension may start it. Run it again after pulling a new version of the helper.
#   ./install.sh               set it up
#   ./install.sh <add-on id>   set it up for an add-on id shown in chrome://extensions, if it differs
#   ./install.sh --uninstall   remove it (the add-on then works as before, without hiding other apps)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
app="$HOME/Library/Application Support/BOON Focus"
dir="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
file="$dir/com.boon.focus.json"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$file" "$app/boon-focus-host" "$app/watch.js" "$app/actions.js"
  rmdir "$app" 2>/dev/null || true
  echo "BOON Focus helper removed."
  exit 0
fi

# Chrome names an unpacked add-on after its folder's real path (as stored on disk, so letter case counts): the first
# 32 hex digits of its SHA-256, 0-f as a-p.
ext="$(/bin/realpath "$here/../extension" 2>/dev/null || (cd "$here/../extension" && pwd -P))"
id="${1:-$(printf '%s' "$ext" | shasum -a 256 | cut -c1-32 | tr '0-9a-f' 'a-p')}"
case "$id" in *[!a-p]* | '') echo "That isn't an add-on id: $id" >&2; exit 1 ;; esac
[ "${#id}" -eq 32 ] || { echo "That isn't an add-on id: $id" >&2; exit 1; }

mkdir -p "$app" "$dir"
# Copy, then rename over the old file, so a helper that is running right now keeps reading its own copy.
for f in boon-focus-host watch.js actions.js; do
  cp "$here/$f" "$app/.$f.new"
  chmod 755 "$app/.$f.new"
  mv -f "$app/.$f.new" "$app/$f"
done
path="$(printf '%s' "$app/boon-focus-host" | sed 's/\\/\\\\/g; s/"/\\"/g')"
cat >"$file.new" <<EOF
{
  "name": "com.boon.focus",
  "description": "BOON Focus helper: hides other apps during a BOON focus session",
  "path": "$path",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$id/"]
}
EOF
mv -f "$file.new" "$file"
echo "BOON Focus helper set up for add-on $id."
echo "Check that this is the ID on the BOON Focus card in chrome://extensions. If it isn't, run:"
echo "  $0 <the ID on the card>"
echo "Then click the reload arrow on BOON Focus to use it."
