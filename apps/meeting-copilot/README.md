# Meeting Copilot

An installable web app (PWA) for meetings. It provides live captions in your language, lets you ask questions about the meeting, catches you up on what you missed, and writes minutes. The AI and the saved history stay in the browser, using Chrome's built-in AI (Gemini Nano). Mic speech is the one exception: see Privacy.

Design direction (Material 3 / Google Workspace feel, theme switching): see [DESIGN.md](DESIGN.md). Next features: [ROADMAP.md](ROADMAP.md).

## Run

```bash
pnpm install
pnpm dev          # http://localhost:5174
pnpm test         # unit tests (Vitest)
pnpm build && pnpm preview   # production build with service worker, http://localhost:4173
```

Open it in **desktop Chrome 138+**. Add `?demo` to the URL (e.g. `http://localhost:5174/?demo`) to get a **Play demo transcript** button for trying captions, Q&A and minutes without speaking.

Check model status at `chrome://on-device-internals`. The first use of each API downloads a model, and the app shows progress.

## End-to-end testing in real Chrome

`test/e2e/chrome.sh` launches a visible Chrome with its own test profile and a debugging port, which `agent-browser connect 9333` attaches to. Don't let `agent-browser open` launch Chrome itself: it passes `--disable-component-update`, so Gemini Nano never downloads and every `availability()` call hangs.

```bash
powershell -File test/e2e/make-audio.ps1     # one-time: spoken meeting WAVs via Windows TTS
npx serve test/e2e -l 4180                   # fake "meeting tab" that plays remote.wav
bash test/e2e/chrome.sh ai                   # or: bash test/e2e/chrome.sh audio
```

Results from 2026-11-22, Chrome 157, after a ~2 min first-time model download:

| Check | Result |
|---|---|
| Translated captions (en→zh) | ✅ |
| Q&A with timestamp citation | ✅ ~12 s |
| Catch me up (key points) | ✅ ~15–25 s |
| Minutes: summary, decisions, 4 action items with owners and due dates, open question | ✅ ~70 s for 11 lines |
| Rich copy for email, mailto draft | ✅ |
| Room mic via on-device Web Speech (🔒) | ✅ |
| Tab audio → Prompt API audio transcription | ✅ near-verbatim, ~5 s per sentence |

The floating caption window and real speech still need a quick manual check by a person.

## Features

| Feature | How it works |
|---|---|
| Room mic captions | Web Speech API, run on-device when Chrome supports it for the language (badge shows 🔒 or ☁️) |
| Remote speaker captions | Share the Teams/Zoom/Meet **browser tab** with "Also share tab audio". Audio is split at pauses (`VoiceChunker`), and each clip is transcribed by the **Prompt API audio input** |
| Translated captions | Translator API, one cached translator per language pair, results kept in spoken order |
| Floating captions | Document Picture-in-Picture: the captions panel moves into an always-on-top window |
| Ask the meeting | Prompt API answers from the transcript and cites `[HH:MM:SS]` timestamps; long meetings keep the most recent context that fits |
| Catch me up | Summarizer TL;DR of the last 2 / 5 / 10 minutes |
| Minutes | Summarizer key points (summary-of-summaries for long meetings) plus Prompt API JSON-schema extraction of decisions, action items and open questions |
| Export | Rich-HTML copy that pastes as formatted text with a table into Outlook/Teams; `.md` download; `mailto:` draft; Web Share |
| History | IndexedDB, searchable across titles, transcripts, translations and minutes |
| Stays awake | Screen Wake Lock while capturing |

## Layout

```
src/
  lib/model.ts        Meeting / Segment types, language lists
  lib/transcript.ts   pure helpers: format, windowing, chunking, search   (tested)
  lib/ai.ts           availability-with-timeout, create-with-progress
  lib/translate.ts    TranslatorPool
  lib/assistant.ts    Q&A, catch-up, minutes                              (merge logic tested)
  lib/export.ts       Markdown / inline-styled HTML / mailto              (tested)
  lib/markdown.ts     safe Markdown subset → DOM (textContent only)       (tested)
  lib/db.ts           IndexedDB store + debounced autosave                (tested)
  audio/chunker.ts    pause-based PCM segmentation                        (tested)
  audio/sources.ts    mic (Web Speech) and tab audio (getDisplayMedia → AudioWorklet → Prompt API)
  ui/                 history view, meeting view, PiP, DOM helpers
public/pcm-worklet.js AudioWorklet that batches PCM to the main thread
```

## Known limits

- **Desktop Chrome only.** Built-in AI isn't available on mobile, Edge, Firefox or Safari.
- **Tab-audio transcription** is limited to English, Spanish and Japanese (the Prompt API's output languages). Other languages need the room mic.
- **Malay and Tamil** mic speech isn't available on-device and goes to Google's speech service. Malay isn't supported by the Translator.
- **Q&A and minutes** are tuned for English transcripts.
- **No speaker identification**: lines are labelled only "Room" (mic) or "Remote" (tab).
- If the mic picks up the meeting from your speakers while tab audio is also on, lines appear twice. Use headphones.

## Privacy

Transcripts, translations, answers and minutes are produced on-device and saved only in this browser's IndexedDB. The one exception is mic speech when on-device recognition isn't available: the ☁️ badge shows that Chrome is using Google's speech service.
