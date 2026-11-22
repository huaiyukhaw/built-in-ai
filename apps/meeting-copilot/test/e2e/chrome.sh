#!/usr/bin/env bash
# Launch a real (headed) Chrome for end-to-end testing of Meeting Copilot with built-in AI,
# then drive it with:  agent-browser connect 9333
#
#   ./chrome.sh ai      # normal Chrome: Gemini Nano, Translator, Summarizer, Q&A, minutes
#   ./chrome.sh audio   # + fake media: tab share auto-picks "Fake Meeting", mic permission auto-granted
#
# Why not `agent-browser open` directly? It launches Chrome with --disable-component-update and
# --disable-background-networking, so Gemini Nano's manifest never downloads and every
# LanguageModel/Summarizer.availability() call hangs. Launch Chrome ourselves and attach over CDP.
#
# Prereqs: `pnpm build && pnpm preview` (app on :4173), `npx serve test/e2e -l 4180` (fake meeting),
#          `powershell -File test/e2e/make-audio.ps1` (generates room.wav / remote.wav).
# The test profile keeps the downloaded models (~4 GB) between runs. Delete the folder to reset.
set -euo pipefail

MODE="${1:-ai}"
CHROME="${CHROME:-$LOCALAPPDATA/Google/Chrome/Application/chrome.exe}"
PROFILE="${PROFILE:-$LOCALAPPDATA/meeting-copilot-test-chrome}"
HERE="$(cd "$(dirname "$0")" && pwd -W 2>/dev/null || pwd)"

args=(--remote-debugging-port=9333 "--user-data-dir=$PROFILE" --no-first-run --no-default-browser-check)
url="http://localhost:4173/?demo"

if [[ "$MODE" == "audio" ]]; then
  # Notes from testing:
  # - Web Speech recognition ignores the fake capture file and uses the REAL default microphone.
  # - With --use-fake-device-for-media-stream, getDisplayMedia audio is the fake file (room.wav),
  #   not the tab's sound. Both still exercise the full capture → transcription pipelines.
  args+=(--use-fake-ui-for-media-stream --use-fake-device-for-media-stream
         "--use-file-for-fake-audio-capture=${HERE//\//\\}\\room.wav"
         "--auto-select-tab-capture-source-by-title=Fake Meeting"
         --autoplay-policy=no-user-gesture-required)
  url="http://localhost:4180/fake-meeting.html"
fi

exec "$CHROME" "${args[@]}" "$url"
