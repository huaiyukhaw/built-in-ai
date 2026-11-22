# Research: Modern Web Guidance, Chrome built-in AI, DevTools AI assistance

_Spike date: 2026-11-16_

Three different things share the "AI + Chrome" label. They sit at different points in the workflow:

| | **Modern Web Guidance (MWG)** | **Built-in AI APIs** | **DevTools AI assistance** |
|---|---|---|---|
| Who uses it | Your coding agent (Claude Code, Copilot CLI, …) | Your **end users**, inside your web app | You, while debugging in Chrome |
| What it is | Skills + CLI that feed curated web-platform guides and Baseline compatibility data to the agent | JS APIs (`Summarizer`, `Translator`, `LanguageModel`, …) backed by Gemini Nano on-device | Gemini panel in DevTools for styling, network, sources, performance |
| Runs where | Your dev machine (`npx modern-web-guidance`) | User's browser, offline, no keys | Google cloud (Gemini), needs sign-in and opt-in |
| Cost | Free | Free per call; one-time model download (~GBs) on user device | Free, but data is sent to Google |

---

## 1. Modern Web Guidance: how it helps day-to-day web dev

**What it is:** a plugin (installed here as `modern-web-guidance@googlechrome` v1.0.0, stable since Nov 2026) with two skills: `modern-web-guidance` and `chrome-extensions`. The agent runs:

```sh
npx -y modern-web-guidance@latest search "<2–5 word capability>"   # find guide ids
npx -y modern-web-guidance@latest retrieve "<id>,<id>"              # full guide
npx -y modern-web-guidance@latest legacy-scan <path> --json         # modernization audit
```

**What it changes in practice** (seen in this spike):

- **Stops agents writing 2019-era code.** Guides push native primitives (`<dialog>`, Popover API, anchor positioning, container queries, `field-sizing`, `light-dark()`) over JS libraries.
- **Built-in pitfalls.** For example, the `progress` guide warns that setting `border-radius` or `background` on `<progress>` silently drops native styling, so use `accent-color` or go fully custom. It also says to announce completion through a `role="status"` region rather than by moving focus. The spikes follow this.
- **Baseline-aware fallbacks.** Each guide lists browser support. Features that are not "Baseline widely available" must ship the guide's fallback unless the project states its own browser-support policy (put that in `CLAUDE.md` / `AGENTS.md`).
- **Volatile-feature gate.** Guides for single-engine APIs (Prompt API, Summarizer, Translator, Language Detector) are locked until the project opts in with `npx modern-web-guidance@latest set-allow-volatile-features`. Without the opt-in, the agent should fall back to a cross-browser solution unless the user named the API explicitly.
- **Modernization audits.** `legacy-scan` finds legacy patterns (it covers about 20% of the catalog that has deterministic rules), each with keep/drop rules to filter false positives. This is useful for brownfield code and for **Mendix custom widgets / pluggable widgets**, which are plain React + CSS.
- **Pairs with Chrome DevTools for agents.** The agent can run a real perf trace or a11y-tree check, then apply the matching guide's fix.

**Suggested team adoption:**
1. Install per repo (`npx modern-web-guidance@latest install`) so every agent session uses it.
2. Add a browser-support line to `CLAUDE.md`, e.g. `**Browser Support:** Baseline widely available; newly available allowed with feature detection.`
3. Run `legacy-scan` on existing widget and theme repos once, as a modernization backlog.

## 2. Built-in AI APIs: status as of Nov 2026

| API | Status | Use it for |
|---|---|---|
| Translator | Stable, Chrome 138 | Translate user-generated content and replies |
| Language Detector | Stable, Chrome 138 | Pick the source language, set `lang` for screen readers |
| Summarizer | Stable, Chrome 138 | TL;DR, key points, headlines, review summaries |
| Prompt API (`LanguageModel`) | Stable on web, Chrome 148 | Free-form tasks, **structured JSON output** (`responseConstraint`), image/audio input |
| Writer / Rewriter | Developer trial (flag) | Draft from an idea, change tone or length |
| Proofreader | Developer trial (flag) | Grammar/spelling with character-offset corrections |

**Common lifecycle:** `'X' in self` → `X.availability(opts)` → `X.create({ ...opts, monitor })` (needs a user gesture if the model must download) → use → `destroy()`.

**Constraints to plan around:**
- Desktop Chrome only (Windows 10+, macOS 13+, Linux, ChromeOS Plus). Needs about 22 GB free disk, and a GPU with more than 4 GB VRAM or 16 GB RAM / 4 cores on CPU. Not Android, iOS or Edge.
- First use downloads the model, so a download-progress UI is mandatory (see `shared/ai.js`).
- Small context window: use the summary-of-summaries pattern (spike 3) and session compacting for chat.
- Not cross-browser. Treat it as progressive enhancement, with a cloud fallback (Firebase AI Logic) or a polyfill if the feature is core.
- Mendix apps run in the browser, so these APIs can be called from a JavaScript action or pluggable widget with no backend, no API key, and no data leaving the device. That suits PDPA-sensitive data.

## 3. DevTools AI assistance

Gemini in DevTools, opened with **Ctrl+Shift+P → "AI assistance"**. It is off by default: enable it under Settings → AI innovations. It needs a signed-in user aged 18+ in a supported region.

- **Styling:** select an element, ask "center this" or "why is this overflowing", and apply the suggested CSS live.
- **Network:** "why does this request fail?", explains headers, writes bug reports.
- **Sources:** "what is this file for?" for third-party or minified scripts.
- **Performance:** "help me optimize LCP" from a recorded trace.
- **Caveat:** page data goes to Google. Enterprise policy controls logging and training, so check before using it on client systems.

It complements MWG: DevTools AI is for interactive debugging by a human, MWG for code an agent writes.

## 4. Spikes built (see `/spikes`)

| # | Spike | APIs | Maturity | Business fit |
|---|---|---|---|---|
| 1 | Multilingual support inbox | Language Detector + Translator | Stable | Support portals for MY/SEA customers (BM, Chinese, Tamil, Indonesian) |
| 2 | Smart form fill (text/photo → form) | Prompt API + JSON Schema + image | Stable (image input may vary) | Leave and expense claims, case intake, any Mendix data-entry form |
| 3 | Summarize long content | Summarizer (+ chunking) | Stable | Meeting notes, ticket threads, review summaries |
| 4 | Writing assistant | Proofreader + Rewriter + Writer | Dev trial (flags) | Comment boxes, emails, notes |

### Creative builds: built-in AI combined with other browser APIs

Built-in AI is most interesting when the browser also provides the input (mic, camera, screen) and the output surface (voice, floating window, share sheet). That way the whole loop stays on-device.

| # | Build | Browser APIs combined | Who it's for |
|---|---|---|---|
| 5 | **Meeting Copilot**: translated live captions in a floating always-on-top window, then minutes and action items | Web Speech recognition, Translator, Document Picture-in-Picture, Summarizer, Prompt API (JSON), Web Share | Multilingual project meetings; staff following a meeting in their second language |
| 6 | **Hands-free site inspection**: push-to-talk fills and *corrects* a report; photo → visible defects; GPS; spoken read-back | Web Speech, Prompt API (JSON + image), getUserMedia, OffscreenCanvas, Geolocation, Speech synthesis, Web Share (with files) | Field technicians, facility audits, insurance surveys (classic Mendix mobile/PWA territory) |
| 7 | **Screen Buddy**: share a window, ask by voice; floats over the app; "watch mode" explains error dialogs as they appear | Screen Capture (`getDisplayMedia`), Prompt API (image), Document PiP, Web Speech | Support desks, onboarding to complex ERP screens, developers reading stack traces |
| 8 | **Speaking partner**: spoken role-play with inline grammar corrections, suggested replies, tap-to-translate, final feedback | Prompt API (JSON, multi-turn, `clone()`), Web Speech recognition + synthesis, Translator | Staff language training, interview practice |

**Ideas not built yet:** WebMCP (origin trial) to expose app actions as tools for browser agents; Idle Detection + Summarizer for a "catch me up" view when you return to a busy channel; MediaRecorder + Prompt API audio input for voice notes with no speech service involved; File System Access API to save outputs straight into a local project folder.

### Limits found while building

- **Malay is missing from the Translator API** (`en→ms` returns `unavailable` on Chrome 157, while zh, ta and id are supported). Spike 1 falls back to the Prompt API, but its declared output languages are only **en, es, ja**, so Malay output quality is unverified.
- **The Prompt API is the narrowest link for language features:** only English, Spanish and Japanese outputs are supported, which is why spike 8 offers just those.
- **On-device speech recognition** needs Chrome 139+ (`SpeechRecognition.available()`, `install()`, `processLocally`). Otherwise audio goes to Google's speech service, and the pages show a badge saying which path is active. Probed on Chrome 157: en-US, zh-CN, ja-JP and es-ES are `downloadable` on-device; **ms-MY and ta-IN are `unavailable`**, so Malay and Tamil speech always goes to the cloud service.
- **`availability()` hung** for the Prompt API and Summarizer in a fresh Chrome profile. All pages now time out after 8 s and show `timeout` instead of spinning.
- **Modern Web Guidance has no guides** for Web Speech, Document PiP or Screen Capture yet, so those parts follow MDN.

Run them with `npx serve spikes` (or any static server) and open in **desktop Chrome**, not an embedded browser.
