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

### 2. Build the minutes during the meeting · ✅ done 2026-11-23
**What was built:**
- **Windows:** while live, the transcript is cut into windows of ~3,000 characters (~3–4 minutes of talk), or a smaller one after 3 minutes. Each window gets Summarizer key points and Prompt API extraction in the background, one at a time, and is saved on the `Meeting` (`rolling`), so a reload keeps it.
- **"So far" card:** in the Minutes tab, it shows the action items and decisions found so far.
- **End / Generate minutes:** only reads what's left, then merges. The summary of summaries is told the extracted decisions and action items, so a long meeting's summary isn't all status chatter.
- **`ModelGate`:** Q&A, catch-up and Generate minutes abort background work at once; background work waits while remote audio is being transcribed.
- **`merge.ts`:**
  - collapses reworded repeats (word stems, "migrate" = "migration");
  - never uses "Room"/"Remote" as an owner;
  - takes the owner from "<Name> will …";
  - turns "<Name> will …" filed as a decision into an action item.
- **Extraction prompt:** placeholders only. With concrete examples, Gemini Nano copied them into real minutes ("we agreed to keep the old site for a year", due "next Friday").

**Results** (eval, Chrome 157; the per-window results are now saved in eval runs):

| | v0.1 single pass | Rolling windows |
|---|---|---|
| Recall, all items | 93% | 89% |
| Action items found | 94% | **100%** |
| Owners | 100% | **60%** ⚠ |
| Due dates | 100% | 94% |
| Summary coverage | 93% | 93% (100% in 2 of 5 runs) |
| Long meeting (400 lines) | 50% | 75–100% across 5 runs |
| Made-up text in minutes | 0 seen | 0 (after removing examples) |

- **Speed:** in the live demo, End → minutes took ~30 s instead of ~70 s, because most work was done during the meeting. The 10 s target wasn't met: combining window summaries is still one Summarizer pass.
- **Owners regressed** when the leaky example ("Siti will run the session" → Siti) was removed. It was also flattering the eval, since Siti is a name from the samples. A blank owner shows as "—", which is safer than invented text. **#4 Speaker names fixes this at the source** by putting names in the transcript the model reads.
- **Run-to-run variation is large** (±1–2 items per sample). Compare totals over more than one run before acting on a small change.
- **The long-meeting sample is harsher than a real meeting:** one real line among ~50 lines of chatter. The model sometimes returns a chatter line as a decision or misses Grace's line in its window.

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

**Build order (agreed 2026-11-22):** #2 → #4 Speaker names → #1 Duplicate lines → #5 Agenda tracker → #11 Glossary → #12 Slide-aware notes. Each feature gets its own commit.

Other ideas from the same brainstorm, not yet scheduled: open existing recordings or transcripts (File Handling / Share Target), "someone said your name" alerts (Notifications + Badging), action items across meetings, ask by voice with a spoken answer, live interpreting into earphones, chapters with an optional local recording, whiteboard photo into the minutes, Writer/Rewriter follow-up email, slowing background work when the CPU is under pressure.

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

### 6. Teams / Zoom desktop apps · ✅ done 2026-11-22
Clicking the remote-captions button now asks **"Where is your meeting?"**: in a browser tab, or in the Teams/Zoom app. Each choice explains what to pick in Chrome's share picker, opens the picker on the matching tab (`displaySurface` hint), and is remembered. The desktop-app choice uses an entire-screen share with system audio.
- Verified with fake media in Chrome 157: a screen share (`displaySurface: monitor`) with audio is transcribed and translated like a tab.
- A share with no audio now says what to fix, depending on what was picked. A single window → "share your entire screen instead"; a screen without "Share system audio" ticked → "turn it on"; a tab → "keep tab audio on".
- **Bug fixed on the way:** the Translator was created only after two `availability()` checks, and by then the share picker had used up the click's user activation. A first-time translation download then failed, every caption said "Translation unavailable", and the failure was cached. Translators are now created straight away inside the click, and failures other than "unsupported pair" are retried on the next click.
- **Checked by hand:** a real Teams desktop call with "Share system audio" ticked works.

### 11. Glossary for better captions · size S
Proper nouns are where captions go wrong: "read-only" heard as "red only", Malaysian names, project terms like "FPX" or "IC numbers".
- A glossary per meeting (names, project terms), pre-filled from the last meeting with the same title and from a default list in Settings.
- Remote audio: add the glossary to the Prompt API transcription prompt ("these words may appear: …").
- Room mic: pass the terms to Web Speech as phrase hints where Chrome supports them; otherwise fix obvious near-misses after the fact.
- Q&A and minutes get the glossary too, so names are spelled the same everywhere.
- Fits with #4: speaker names found by introductions are added to the glossary automatically.
- Check: re-run the e2e audio test with "read-only" in the glossary, and add an eval sample with unusual names.

### 12. Slide-aware notes · size M
The screen or tab share already includes video, which the app currently ignores.
- Watch the shared video at low cost: compare a small thumbnail every ~2 s and capture a full frame only when the picture changes a lot (a new slide).
- Prompt API image input reads each new slide: title, main text, any numbers. Duplicate slides (going back) are recognised and skipped.
- **Slides are translated into the caption language** (Translator, the same pool as captions), so someone following in Chinese sees the slide text in Chinese next to the original. Optional: show the translated slide in the floating captions window.
- Slides appear as cards inline with the captions at the moment they were shown. They feed Q&A ("what was on the pricing slide?") and the minutes ("Slides shown: …").
- Slide reading runs as background work through `ModelGate`, so it never delays live transcription.
- Privacy: frames are processed on-device; only the extracted text is saved, never the image, unless the user turns that on.

---

## Round 3: deferred (2026-11-22)

_Parked by decision; each needs a product decision before any work. Revisit after Round 2._

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
