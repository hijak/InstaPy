#!/usr/bin/env bash
# Install a LaunchAgent that runs two bounded InstaPy Reborn sessions per day
# (10:07 and 19:23 local time, with up to 20 minutes of start jitter so the
# schedule isn't metronomic). The agent only runs while you're logged in.
#
#   scripts/install-launchd.sh              # install (does NOT auto-load)
#   LAUNCH_AGENTS_DIR=/tmp/x scripts/install-launchd.sh   # lint-test elsewhere
#
# After installing, load it when you're ready:
#   launchctl load ~/Library/LaunchAgents/com.instapy.reborn.session.plist
# Remove:
#   launchctl unload ~/Library/LaunchAgents/com.instapy.reborn.session.plist \
#     && rm ~/Library/LaunchAgents/com.instapy.reborn.session.plist
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.instapy.reborn.session"
TARGET="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"

NODE_BIN="$(command -v node)" || { echo "node not found on PATH" >&2; exit 1; }
EGO_BIN="$(command -v ego-browser)" || { echo "ego-browser not found on PATH" >&2; exit 1; }
EGO_DIR="$(dirname "$EGO_BIN")"

mkdir -p "$TARGET" "$APP_DIR/data"

sed \
  -e "s|__NODE__|$NODE_BIN|g" \
  -e "s|__APP_DIR__|$APP_DIR|g" \
  -e "s|__EGO_PATH__|$EGO_DIR|g" \
  "$APP_DIR/scripts/$LABEL.plist.template" > "$TARGET/$LABEL.plist"

plutil -lint "$TARGET/$LABEL.plist"

echo
echo "Installed: $TARGET/$LABEL.plist  (not loaded yet)"
echo "Load:      launchctl load $TARGET/$LABEL.plist"
echo "Unload:    launchctl unload $TARGET/$LABEL.plist"
echo "Logs:      $APP_DIR/data/launchd.log"
