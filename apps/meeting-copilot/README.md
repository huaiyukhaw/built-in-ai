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

`test/e2e/chrome.sh` launches a visible Chrome with its own test profile and a debugging port, which `agent-browser connect 9333` attaches to. Don't let `agent-browser open` launch Chrome itself: it passes `--disable-component-update`, so Gemini Nano never downloads and every `availability()` call hangs. The script always uses the one test profile (`D:\chrome-profiles\meeting-copilot-test-chrome`, on D: because C: is nearly full; `TEST_PROFILE_DIR` moves it) and reuses a test Chrome already on port 9333, because each new profile downloads Gemini Nano (~4 GB) again.

```bash
powershell -File test/e2e/make-audio.ps1     # one-time: spoken meeting WAVs via Windows TTS (mixed.wav: English and Japanese turns)
npx serve test/e2e -l 4180                   # fake "meeting tab" that plays remote.wav (?slides adds a slide deck)
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
| Desktop-app path (entire screen + system audio), with fake media | ✅ captions and translation; picker shows the right hint per choice; a screen share without audio gives a clear fix |

Still needs a quick manual check by a person: the floating caption window, real speech, and a real Teams or Zoom desktop call with "Share system audio" ticked. That checkbox is in Chrome's own picker, which automation can't tick.

### Minutes quality eval

Run this before merging any change to the minutes prompts or pipeline.

```bash
pnpm dev                        # serves http://localhost:5174/eval.html
bash test/e2e/chrome.sh ai      # then open /eval.html in that window and press "Run evals"
```

- **Samples:** `test/evals/samples/*.json` holds six transcripts: a plain meeting, remote speaker introductions, conditional and rejected decisions, a meeting with no action items, Malaysian names, and a long meeting (about 400 lines) that forces chunking. Each has expected decisions, action items (with owner and due date) and open questions, written as keyword lists. Three also have an agenda with the expected status of each item (decided, discussed or not covered). `misheard-terms` is written the way Web Speech mishears names and has a glossary; `forbidText` counts misheard spellings that reach the minutes as traps. `?noglossary` runs without glossaries, to measure what they add.
- **Scoring:** the scorer (`src/eval/score.ts`, unit-tested) matches keywords at word starts. It reports recall, owner and due accuracy, extra items, "traps" (rejected proposals that came back as action items), and agenda accuracy.
- **Baseline:** download the JSON and save it as `test/evals/results/baseline.json`. The page then shows each new run's change against it. The current baseline is from the agenda tracker (2026-11-23); ROADMAP.md #2–#5 record each step's numbers.
- **Options:** `?only=id1,id2` runs some samples only; `?autorun` starts at once. Results vary between runs, so treat a change of one item as noise.

### Transcription replay and diagnostics

Run this before changing anything in how remote audio (or the two-way room mic) is chunked or transcribed.

```bash
powershell -File test/e2e/make-realistic.ps1                       # meeting-like speech: fast, short gaps, a quiet speaker
node test/e2e/degrade.mjs realistic-en.wav near-en.wav --gain -8   # a speaker across the room (also --snr, --reverb)
pnpm dev                                                           # then open /replay.html?wav=/test/e2e/near-en.wav&langs=en and press Start
```

`/replay.html` runs a recording through the same chunker and Gemini Nano transcriber as the app and scores it against the `.txt` next to it: word error rate for English, character error rate for Japanese, with "missed" counted separately. Any `VoiceChunker` option can be overridden in the URL (`&minChunkMs=4000`), and `&normalize=0` sends clips at their recorded level.

Results on 2026-11-25 (Chrome 158), error rate:

| Recording | Before (fixed RMS 0.01 threshold) | After (threshold relative to noise, pre-roll, gain) |
|---|---|---|
| realistic-en (clean TTS) | 0.7% | 1.0% |
| near-en (−8 dB, reverb, noise) | 81.5%, most speech dropped as silence | 5.3–6.3% |
| room-en (−18 dB, reverb, noise) | 100%, nothing transcribed | 11.6% |
| realistic-mixed (English + Japanese) | 8.5%, a clipped first word, 水曜日 → 土曜日 | 4.5% |

Longer clips run faster but miss more (6 s minimum: ×0.84 real time, 8.6%; 1.5 s: ×1.07, 5.3%), so the 1.5 s minimum stays.

**Real meetings:** Settings → Troubleshooting → **Save transcription diagnostics** records, while a meeting is live, the shared-tab audio and the two-way room mic to a folder you pick (a WAV per source and `log.jsonl`: each clip's place in the recording, its wait in the queue, model time, text or error, audio dropped as silence, room-mic lines removed as echo, slide reads). Copy a meeting's folder to `test/e2e/local/` (gitignored) and open `/replay.html?wav=/test/e2e/local/<folder>/tab.wav&log=/test/e2e/local/<folder>/log.jsonl&langs=en,ja` to replay it next to what the app wrote live.

## Features

| Feature | How it works |
|---|---|
| Room mic captions | Web Speech API, run on-device when Chrome supports it for the language (badge shows 🔒 or ☁️) |
| Remote speaker captions | A short "Where is your meeting?" dialog, then Chrome's share picker. **Browser tab** (Teams/Zoom/Meet in Chrome): pick the tab and keep "Also share tab audio" on. **Desktop app** (Teams/Zoom on Windows): pick "Entire screen" and turn on "Share system audio". Audio is split at pauses (`VoiceChunker`), and each clip is transcribed by the **Prompt API audio input** |
| Speaker names | A line like "Hi, this is Priya", "Daniel here" or "It's Aisha" names that speaker, and the name carries forward on that source (room mic or remote audio) until someone else introduces themselves. A question put to someone by name ("Wei Ming, can you chase them?") names the next answer from the other source. Click a speaker label to rename it; the run of lines with that label changes. Names go into the transcript the model reads (`Priya (Remote): …`), so Q&A and minutes use them |
| No double lines | When the room mic hears the meeting through the laptop speakers, its copy of a remote line is removed. The mic goes to Web Speech as an echo-cancelled track (`getUserMedia` → `SpeechRecognition.start(track)`), which helps when the meeting plays in Chrome. While remote audio is on, mic lines are shown dimmed for up to 20 s and dropped if a remote line with the same content words arrives (`EchoFilter`); a one-time message suggests headphones |
| Translated captions | Translator API, one cached translator per language pair, results kept in spoken order |
| Two-way meetings | For meetings in two languages, such as English and Japanese: tick **Both languages are spoken** in the language menu (or in Settings for new meetings). Each line is translated into the other language; a line in neither (someone switches to Chinese) is translated into English. Lines are told apart by script, words and Chrome's on-device **LanguageDetector**. The room mic and remote audio are both transcribed by the Prompt API, told to write each word in the language spoken, because Web Speech listens for one language. Q&A and minutes read English: Japanese lines in their English translation. Japanese introductions (「こんにちは、田中です」) name speakers, and "-san" is dropped from names |
| Floating captions | Document Picture-in-Picture: the captions panel moves into an always-on-top window |
| Slide-aware notes | The video of a tab or screen share is watched for new slides: every 2 s a 64×36 thumbnail is compared by its "ink" (pixels that stand out from the background), and a full frame is taken only when the picture settles on something new (`SlideDetector`). The Prompt API's **image input** first says what kind of screen it is, then, for a slide, document or spreadsheet, reads the title and main points. Cards appear in the captions at the time the slide was shown, translated into the caption language. A bullet appearing updates the card; going back to an earlier slide adds nothing. Slides feed Q&A and are listed in the minutes. Reading runs as background work, after transcription. Only the text is saved, never the picture |
| Ask the meeting | Prompt API answers from the transcript and the slides shown, and cites `[HH:MM:SS]` timestamps; long meetings keep the most recent context that fits |
| Catch me up | Summarizer TL;DR of the last 2 / 5 / 10 minutes |
| Minutes | Drafted in the background while you're live, ~3 minutes of talk at a time: Summarizer key points plus Prompt API JSON-schema extraction of decisions, action items and open questions. A **So far** list of action items grows in the Minutes tab. End or Generate minutes only reads the rest and merges (near-duplicates collapse; "Room"/"Remote" are never used as owners) |
| Names and terms | A glossary per meeting in the Agenda tab, plus terms for every meeting in Settings. Speaker names are added when people introduce themselves. The room mic gets them as Web Speech hints (`SpeechRecognitionPhrase`, on-device recognition, Chrome 157), remote audio in the transcription prompt, and Q&A and minutes in their prompts. Finished lines are corrected to the listed spelling ("red only" → "read-only", "fpx" → "FPX"; `correctTerms`). An earlier meeting with the same title offers its terms |
| Agenda | An Agenda tab: paste the agenda (one item per line) and, optionally, the planned length. Each background minutes window is checked against it with the Prompt API (JSON schema of item numbers), then checked against the words actually said (`groundCheck`). Items show as not yet, discussed or decided. While live, the tab shows "12 min left · 2 items not covered", and a message appears at 10 min left and at time up if items are still open. Items nobody got to go into the minutes as open questions, and the export lists the agenda with each status |
| Sharing the model | One on-device model does everything. Background work (minutes, slide reading) waits until every queued clip is transcribed and stops at once when you ask a question (`ModelGate`). End waits for queued clips before writing the minutes |
| Export | Rich-HTML copy that pastes as formatted text with a table into Outlook/Teams; `.md` download; `mailto:` draft; Web Share |
| History | IndexedDB, searchable across titles, transcripts, translations and minutes |
| Stays awake | Screen Wake Lock while capturing |

## Layout

```
src/
  lib/model.ts        Meeting / Segment types, language lists
  lib/glossary.ts     names and terms: parsing, near-miss correction      (tested)
  lib/bilingual.ts    two-way meetings: which language a line is in, where it is translated (tested)
  lib/detect.ts       Chrome's on-device LanguageDetector
  lib/agenda.ts       agenda parsing, status, grounding, time box        (tested)
  lib/echo.ts         drop mic lines that echo remote speech             (tested)
  lib/speakers.ts     speaker names from introductions, rename           (tested)
  lib/slides.ts       new-slide detection, reading schema, one card per slide (tested)
  lib/transcript.ts   pure helpers: format, windowing, chunking, search   (tested)
  lib/ai.ts           availability-with-timeout, create-with-progress
  lib/translate.ts    TranslatorPool
  lib/assistant.ts    Q&A, catch-up, minutes per window and final merge
  lib/merge.ts        fuzzy de-duplication of items across windows        (tested)
  lib/rolling.ts      background minutes while live                       (tested)
  lib/gate.ts         priorities for the shared model                     (tested)
  lib/export.ts       Markdown / inline-styled HTML / mailto              (tested)
  lib/markdown.ts     safe Markdown subset → DOM (textContent only)       (tested)
  lib/db.ts           IndexedDB store + debounced autosave                (tested)
  audio/chunker.ts    pause-based PCM segmentation                        (tested)
  audio/sources.ts    mic (Web Speech, or the Prompt API in two-way meetings) and tab audio (getDisplayMedia → AudioWorklet → Prompt API)
  audio/slide-watcher.ts  frames of the shared video (MediaStreamTrackProcessor) → SlideDetector
  ui/                 history view, meeting view, PiP, DOM helpers
  eval/               minutes quality scorer (tested) and the /eval.html runner
public/pcm-worklet.js AudioWorklet that batches PCM to the main thread
```

## Deploy (Cloudflare Pages)

**Live:** https://meet.h8w.dev (also https://meeting-copilot-dne.pages.dev; Cloudflare Pages project `meeting-copilot`, created 2026-11-23). `meet.h8w.dev` is a proxied CNAME in the `h8w.dev` zone. The repo must be in the Cloudflare Workers and Pages GitHub app's repository access, or pushes don't reach Cloudflare. Builds run only when something under `apps/meeting-copilot/` changes (`path_includes`); pushes to `main` go to production and other branches get preview URLs.

A static site: `pnpm build` writes `dist/`, and everything else runs in the visitor's Chrome. The Prompt API is stable for web pages since Chrome 148, so no origin-trial token is needed. HTTPS is required (mic, screen capture, Document Picture-in-Picture), which Pages provides.

**Project settings** (already set up; to recreate: Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git):

| Setting | Value |
|---|---|
| Repository | `huaiyukhaw/built-in-ai`, production branch `main` |
| Root directory | `apps/meeting-copilot` |
| Framework preset | None |
| Build command | `pnpm build` (type-checks, then builds) |
| Build output directory | `dist` |
| Environment variables | `NODE_VERSION=24`, `PNPM_VERSION=10.20.0` |

After that, every push to `main` deploys to `<project>.pages.dev`, and other branches get preview URLs. The site serves at the root path, so no Vite `base` change is needed.

**Headers:** `public/_headers` is copied into `dist/` and applied by Pages:
- a Content-Security-Policy that allows scripts only from the site itself (styles allow inline, for icon masks and the floating captions window);
- a Permissions-Policy that allows mic and screen capture for the site and turns off camera and location;
- long caching for hashed `/assets/*`, and `no-cache` on `sw.js` so updates arrive.

The theme script is `public/theme-init.js` rather than inline, so the policy can forbid inline scripts. Checked in Chrome 157 with the headers applied to a production build: demo, translation, Q&A, room mic, remote capture (audio worklet) and the floating window all worked with no policy violations.

**Note for visitors:** the app needs desktop Chrome with the built-in AI models; the first use downloads Gemini Nano (~4 GB, ~20 GB free disk). The eval page (`/eval.html`) is dev-only and not deployed.

## Known limits

- **Desktop Chrome only.** Built-in AI isn't available on mobile, Edge, Firefox or Safari.
- **Remote-speaker transcription** is limited to English, Spanish and Japanese (the Prompt API's output languages). Other languages need the room mic.
- **Desktop apps need a whole-screen share.** Chrome can't capture one app window's sound, so the app captures system audio, including notifications and music. System audio is offered on Windows and ChromeOS; on macOS use the meeting's browser version.
- **Malay and Tamil** mic speech isn't available on-device and goes to Google's speech service. Malay isn't supported by the Translator.
- **Q&A and minutes** are tuned for English transcripts.
- **Speaker names come from what people say**, not from their voices. Several people on one source share the last name heard until someone introduces themselves or is asked by name; click the label to fix it.
- **Two-way meetings** need two languages the Prompt API can write (English, Japanese, Spanish). The room mic then has no live word-by-word preview: captions arrive a phrase at a time, a few seconds late. Each translation direction downloads separately; Chrome only downloads one at a time, so the second may need one more click anywhere in the app.
- **Slides are read slowly** while remote audio is busy: 15 s for a slide on its own, 30–90 s when transcription and minutes are also running, because one model does everything. A presenter clicking through faster sees only the last 6 slides read. With an entire-screen share, anything on screen can be read; the model is asked to skip call windows, chats and app screens, but check the cards.
- **Echo removal matches words, not sound.** A room comment that repeats most of what a remote speaker just said can be removed too, and room lines join the transcript up to 20 s late while remote audio is on. Headphones avoid both.

## Privacy

Transcripts, translations, slide text, answers and minutes are produced on-device and saved only in this browser's IndexedDB. The one exception is mic speech when on-device recognition isn't available: the ☁️ badge shows that Chrome is using Google's speech service.
