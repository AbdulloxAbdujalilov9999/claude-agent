#!/bin/bash
# Installs Mina Helper on this Mac: a small background job that lets Mina open apps and
# web pages, control music, set the volume and show notifications. Nothing else.
# Usage: curl -fsSL https://<mina>/helper/install.sh | bash -s -- <pairing-token>
set -euo pipefail

SERVER="${MINA_SERVER:-https://claude-agent-demo.onrender.com}"
TOKEN="${1:-}"
DIR="$HOME/Library/Application Support/Mina Helper"
PLIST="$HOME/Library/LaunchAgents/com.mina.helper.plist"

if [ -z "$TOKEN" ]; then
  echo "Missing pairing token. Copy the full command from Mina → Connect your Mac." >&2
  exit 1
fi

mkdir -p "$DIR" "$HOME/Library/LaunchAgents"
curl -fsSL "$SERVER/helper/mina-helper.js" -o "$DIR/mina-helper.js"
umask 077
printf '%s' "$TOKEN" > "$DIR/token"
printf '%s' "$SERVER" > "$DIR/server"

cat > "$DIR/mina-helper.sh" <<'LOOP'
#!/bin/bash
# Asks Mina for the next job, runs it with mina-helper.js, reports back. Repeats forever.
DIR="$HOME/Library/Application Support/Mina Helper"
SERVER="$(cat "$DIR/server")"
TOKEN="$(cat "$DIR/token")"
while true; do
  JOB="$(curl -sS -m 40 -H "Authorization: Bearer $TOKEN" -w '\n%{http_code}' "$SERVER/api/device/next" 2>/dev/null)" || { sleep 10; continue; }
  CODE="${JOB##*$'\n'}"
  BODY="${JOB%$'\n'*}"
  case "$CODE" in
    200)
      RESULT="$(/usr/bin/osascript -l JavaScript "$DIR/mina-helper.js" "$BODY" 2>&1)"
      curl -sS -m 20 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
        --data-binary "$RESULT" "$SERVER/api/device/result" >/dev/null 2>&1
      ;;
    204) ;;
    401) echo "Mina rejected this Mac's token (password changed?). Re-run the install command." >&2; sleep 300 ;;
    *) sleep 10 ;;
  esac
done
LOOP
chmod 700 "$DIR/mina-helper.sh"

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mina.helper</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$DIR/mina-helper.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$DIR/helper.log</string>
</dict></plist>
PL

launchctl bootout "gui/$(id -u)/com.mina.helper" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Mina Helper is running. Mina can now open apps, play music and more on this Mac."
echo "To remove it: launchctl bootout gui/\$(id -u)/com.mina.helper && rm -rf \"$DIR\" \"$PLIST\""
