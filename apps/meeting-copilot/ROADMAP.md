# Meeting Copilot roadmap

_Written 2026-11-22, right after the first end-to-end test in real Chrome 157 with Gemini Nano. The "Evidence" lines record what was actually observed, so priorities can be re-checked later._

## Where things stand

All v0.1 features work end to end in Chrome with the on-device models (see README → End-to-end testing). Measured on an 11-line demo meeting:

| Feature | Speed | Quality notes |
|---|---|---|
| Translated captions (en→zh) | near-instant per line | good |
| Q&A | ~12 s | correct, cites `[HH:MM:SS]` |
| Catch me up | ~15–25 s | correct; changed from TL;DR (one run-on sentence) to key points |
| Minutes | ~58–71 s | summary good; extraction needed prompt work (see #3) |
| Room mic (on-device Web Speech) | live | accurate ("read-only" heard as "red only") |
| Tab audio (Prompt API audio input) | ~5 s per sentence | near-verbatim; fell 4 clips behind, then recovered |

Not yet verified by a human: the floating caption window, and real speech in a real meeting.

---

## Round 1: fix what testing showed (build next)

### 1. Drop duplicate lines (mic hears the meeting through the speakers) · size S
**Evidence:** with the room mic on, Web Speech used the real laptop mic, which picked up the meeting audio from the speakers and transcribed the remote speaker's lines as "Room".
**Plan:**
- When a mic segment closely matches a tab segment from the last ~10 s (normalised text, token overlap ≥ 0.6), drop it or merge it into the tab line.
- Handle both arrival orders: the mic line can arrive *before* the tab line, because tab transcription lags ~5 s. Keep mic lines "provisional" for a few seconds while tab audio is active.
- Add an onboarding hint and a settings toggle: "Using speakers? Turn on echo filtering."
- Unit-test the matcher with paraphrased and partial transcripts.

### 2. Build the minutes during the meeting · size M
**Evidence:** about 70 s to generate minutes for 11 lines. An hour-long meeting (~600 lines) would mean many chunk passes at the very end.
**Plan:**
- Every ~3 min (or N new lines), run the Summarizer and action-item extraction on just the new window in the background, at idle priority with one job at a time.
- Show a live **Action items** list that grows during the meeting, which is useful on its own.
- "Generate minutes" becomes a fast merge of the rolling results (summary of summaries, de-duplicated action items via `mergeExtractions`).
- Store the rolling results on the `Meeting` so a reload doesn't lose them.
- Pause background work while Q&A is running, so answers stay fast.
- One Gemini Nano instance runs everything, so add a small job queue: live tab transcription first, then Q&A and catch-up, then background minutes. Otherwise rolling minutes will make tab captions lag more than they already do.
- Success check: long-meeting eval recall up from 50%, and "Generate minutes" under 10 s at the end.

### 3. Automated quality check for minutes · ✅ done 2026-11-22
Six samples in `test/evals/samples/`, scorer in `src/eval/score.ts`, runner at `/eval.html` (see README → Minutes quality eval). Baseline in `test/evals/results/baseline.json`, Chrome 157:

| Sample | Time | Decisions | Actions | Owner | Due | Questions | Extra |
|---|---|---|---|---|---|---|---|
| portal-golive | 80 s | 2/2 | 4/4 | 4/4 | 4/4 | 1/1 | 0 |
| remote-intros | 52 s | 1/1 | 4/4 | 3/3 | 4/4 | 1/1 | 0 |
| conditional-rejected | 57 s | 3/3 | 2/2 | 2/2 | 2/2 | – | 2 |
| no-actions | 26 s | – | – | – | – | – | 1 |
| malaysian-names | 40 s | 1/1 | 4/4 | 4/4 | 4/4 | 1/1 | 0 |
| long-meeting (~400 lines, split in 2) | 239 s | **0/1** | **1/2** | 1/1 | 1/1 | 1/1 | 1 |

**What it showed:**
- **Short meetings are solid.** Remote introductions, Malaysian names and rejected proposals were all handled correctly, with no traps hit.
- **Long meetings are the weak spot.** The VPN decision was lost and Grace's SSL task disappeared or was filed as a decision, both in one pass (~230 lines, which fits the 9,216-token context) and when split. This is quality, not only speed, so it strengthens the case for #2: small rolling windows give the model less to search through.
- **Speaker label as owner.** "Remote: Send the request to renew the SMS contract" duplicated Mei Ling's item. The model used the source label instead of carrying the name forward. #4 (speaker names) would fix this; meanwhile, de-duplicate on task similarity, not exact text.
- **Answered questions listed as open.** "How many users are on the beta?" was answered on the next line, yet came back as an open question in 2 of the 6 samples.
- Both the Prompt API and the Summarizer report 9,216 tokens of input. Extraction splits at ~13.8k characters (about 230 short lines).

---

## Round 2: make it stand out

### 4. Speaker names · size M
Lines are only "Room" or "Remote". The model already understood "this is Priya … I will fix …" once prompted to.
- Detect self-introductions ("this is X", "X here", "hi, I'm X") and carry the name forward for that source until another introduction.
- Click a speaker label to rename it; renames apply to the meeting and are used in Q&A and minutes.
- Later: use voice differences (pitch/energy) to split speakers on one source. Research needed.

### 5. Agenda tracker · size M
- Paste or type the agenda before or at the start of the meeting.
- Each window of segments is classified against the agenda items (Prompt API with a JSON schema) to tick off "discussed" and "decided".
- Time-box nudges: "10 min left · 2 items not covered".
- Uncovered items go into the minutes as open questions.

### 6. Teams / Zoom desktop apps · ✅ built 2026-11-22, needs a real-call check
Clicking the remote-captions button now asks **"Where is your meeting?"**: in a browser tab, or in the Teams/Zoom app. Each choice explains what to pick in Chrome's share picker, opens the picker on the matching tab (`displaySurface` hint), and is remembered. The desktop-app choice uses an entire-screen share with system audio.
- Verified with fake media in Chrome 157: a screen share (`displaySurface: monitor`) with audio is transcribed and translated like a tab.
- A share with no audio now says what to fix, depending on what was picked. A single window → "share your entire screen instead"; a screen without "Share system audio" ticked → "turn it on"; a tab → "keep tab audio on".
- **Bug fixed on the way:** the Translator was created only after two `availability()` checks, and by then the share picker had used up the click's user activation. A first-time translation download then failed, every caption said "Translation unavailable", and the failure was cached. Translators are now created straight away inside the click, and failures other than "unsupported pair" are retried on the next click.
- **Still to check by hand:** a real Teams or Zoom desktop call with "Share system audio" ticked, including how notification sounds come through. Automation can't tick that checkbox in Chrome's picker.

---

## Round 3: needs a decision first

| # | Feature | Decision needed |
|---|---|---|
| 7 | **Malay meetings** | Chrome can't do Malay on-device: no Malay in the Translator, ms-MY speech goes to Google, and the Prompt API only outputs en/es/ja. The only route is an **opt-in cloud fallback** (Gemini via Firebase AI Logic) for those meetings, which breaks "nothing leaves the device". Needs a privacy/PDPA stance and a clear UI indicator. Re-probe newer Chrome versions first. |
| 8 | **Push action items to Jira / Planner / Outlook** | Needs sign-in (OAuth) and a small backend or connector. High value for delivery teams. Decide whether Meeting Copilot stays fully client-side. |
| 9 | **Chrome extension version** | Side panel plus `chrome.tabCapture`: no share picker, works across tabs. A separate codebase and Web Store publishing; reuse `src/lib` and `src/audio`. |
| 10 | **WebMCP tools** | Expose `ask_meeting`, `get_action_items` and `catch_up` to browser AI agents. Origin trial; low effort and on-trend, but early. |

## Known limits (carry forward)
- Desktop Chrome only; Edge exposes the Summarizer but not the Prompt API.
- Gemini Nano needs about 20 GB free disk to install (the test laptop had 20.6 GB).
- Testing: don't let agent-browser launch Chrome itself (`--disable-component-update`). Use `test/e2e/chrome.sh`.
