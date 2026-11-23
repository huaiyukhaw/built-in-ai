#!/usr/bin/env bash
# Launch a real (headed) Chrome for end-to-end testing of Meeting Copilot with built-in AI,
# then drive it with:  agent-browser connect 9333
#
#   ./chrome.sh ai      # normal Chrome: Gemini Nano, Translator, Summarizer, Q&A, minutes
#   ./chrome.sh audio   # + fake media: mic and screen/tab share both play a WAV file
#
# ONE test profile, ONE model copy. Gemini Nano (~4 GB) and the Translator/Summarizer packs are
# stored per Chrome profile folder, so every new --user-data-dir downloads them again. This script:
#   - reuses the test Chrome if one is already listening on port 9333 (no second instance);
#   - always uses the same profile folder, and refuses another one unless ALLOW_NEW_PROFILE=1.
# Never let `agent-browser open` launch Chrome itself either: it uses a throwaway profile with
# --disable-component-update, so models never download and every availability() call hangs.
#
# Options (environment): APP_URL (default http://localhost:4173/?demo), WAV (audio mode, default
# room.wav; remote.wav makes mic and share play the same speech, i.e. the echo case).
# Prereqs: the app running (`pnpm dev` on :5174 or `pnpm build && pnpm preview` on :4173), and for
# audio mode `powershell -File test/e2e/make-audio.ps1` (generates room.wav / remote.wav).
set -euo pipefail

MODE="${1:-ai}"
PORT=9333
CHROME="${CHROME:-$LOCALAPPDATA/Google/Chrome/Application/chrome.exe}"
TEST_PROFILE="${TEST_PROFILE_DIR:-/d/chrome-profiles/meeting-copilot-test-chrome}"  # on D:, as C: is nearly full
PROFILE="${PROFILE:-$TEST_PROFILE}"
HERE="$(cd "$(dirname "$0")" && pwd)"
win() { cygpath -w "$1" 2>/dev/null || echo "$1"; }

if [[ "$PROFILE" != "$TEST_PROFILE" && "${ALLOW_NEW_PROFILE:-}" != 1 ]]; then
  echo "Refusing profile $PROFILE: a new profile downloads Gemini Nano (~4 GB) again." >&2
  echo "Use the shared test profile ($TEST_PROFILE), or set ALLOW_NEW_PROFILE=1 if you really mean it." >&2
  exit 1
fi

if curl -s --max-time 2 "http://localhost:$PORT/json/version" >/dev/null; then
  echo "A test Chrome is already running on port $PORT; reusing it (agent-browser connect $PORT)."
  exit 0
fi

if [[ ! -d "$PROFILE/OptGuideOnDeviceModel" ]]; then
  echo "Note: no Gemini Nano in $PROFILE yet. The first run downloads it once (~4 GB, needs ~20 GB free)."
fi

args=(--remote-debugging-port=$PORT "--user-data-dir=$(win "$PROFILE")" --no-first-run --no-default-browser-check)
# Keep pages running at full speed when the window is behind other windows (timers, canvas, video),
# so tests behave the same whether or not the test window is in front.
args+=(--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling)
url="${APP_URL:-http://localhost:4173/?demo}"

if [[ "$MODE" == "audio" ]]; then
  # With --use-fake-device-for-media-stream, getUserMedia (the room mic, passed to Web Speech as a
  # track) and getDisplayMedia audio both play the WAV file instead of real devices.
  args+=(--use-fake-ui-for-media-stream --use-fake-device-for-media-stream
         "--use-file-for-fake-audio-capture=$(win "$HERE/${WAV:-room.wav}")"
         "--auto-select-tab-capture-source-by-title=Fake Meeting"
         --autoplay-policy=no-user-gesture-required)
  url="${APP_URL:-http://localhost:4180/fake-meeting.html}"
fi

exec "$CHROME" "${args[@]}" "$url"
