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

### 1. Drop duplicate lines (mic hears the meeting through the speakers) · ✅ done 2026-11-23
**Evidence:** with the room mic on, Web Speech used the real laptop mic, which picked up the meeting audio from the speakers and transcribed the remote speaker's lines as "Room".
**What was built:**
- **Echo-cancelled mic:** the mic is opened with `getUserMedia({ echoCancellation: true })` and passed to `SpeechRecognition.start(track)`. Spike in Chrome 157: a silent track gives no text and the mic track gives text, so recognition really uses the track. Chrome's echo cancellation only removes sound Chrome itself plays, so this helps for a meeting in a Chrome tab, not for the Teams/Zoom app.
- **Text matching (`src/lib/echo.ts`):** while remote audio is on, mic lines are shown dimmed and held for up to 20 s (a 12 s clip plus transcription). A remote line drops held mic lines that share at least half of the shorter line's content words (at least two; a one-word fragment like "Friday" must appear in the remote line). Mic lines from before the remote clip ended are committed then, so the transcript stays in time order. A mic line arriving after its remote line is dropped at once.
- A one-time message says the mic is hearing the speakers and suggests headphones. No settings toggle: it only acts when both sources are on.

**Results** (Chrome 157, fake mic and fake screen share playing the same recording):
- First run: 4 echoed mic lines removed, including misrecognised ones ("Disability audit…" for "The accessibility audit…", "Priy adjoining"). One one-word fragment ("Friday") stayed held, which led to the one-word rule.
- Second run: all 9 echoed mic lines removed, including fragments ("On the claims form", "Next Friday"). No duplicates and nothing left held.
- **Not verified:** a real room with real speakers and real room speech. The risk is a room comment that repeats a remote line closely being removed.

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
- **Owners regressed** when the leaky example ("Siti will run the session" → Siti) was removed. It was also flattering the eval, since Siti is a name from the samples. A blank owner shows as "—", which is safer than invented text. **#4 Speaker names fixed this at the source** by putting names in the transcript the model reads: owners are back to 100%.
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

**Build order (agreed 2026-11-22):** #2 ✅ → #4 Speaker names ✅ → #1 Duplicate lines ✅ → #5 Agenda tracker ✅ → #11 Glossary ✅ → #12 Slide-aware notes. Each feature gets its own commit.

Other ideas from the same brainstorm, not yet scheduled: open existing recordings or transcripts (File Handling / Share Target), "someone said your name" alerts (Notifications + Badging), action items across meetings, ask by voice with a spoken answer, live interpreting into earphones, chapters with an optional local recording, whiteboard photo into the minutes, Writer/Rewriter follow-up email, slowing background work when the CPU is under pressure.

### 4. Speaker names · ✅ done 2026-11-23
**What was built** (`src/lib/speakers.ts`):
- **Introductions:** "Hi, this is Priya", "Daniel here", "It's Aisha", "Razak speaking", "my name is Mei Ling" name the speaker. Titles are dropped ("Encik Razak" → Razak), and phrases like "this is Monday's plan" or "I'm sure" mid-sentence don't count.
- **Carry forward:** the name stays with that source (room mic or remote audio) until someone else introduces themselves.
- **Asked by name:** "Lim Wei Jie, you're handling the comms?" names the next line from the other source. Without this, Lim's answer was labelled with the previous remote speaker (Muthu).
- **Rename:** click a speaker label, type a name (or leave it empty for "Remote"/"Room"). The run of lines with that label on that source changes. Rolling minutes windows from that point are redone so the "So far" list uses the new name.
- **The model sees names:** transcript lines read `[time] Priya (Remote): …`. The extraction prompt says the owner is the name before the brackets, and `cleanOwner` strips a "(Remote)" the model copies.
- **Demo:** remote speakers now introduce themselves, so the demo shows Kumar, Wei Ming and Ahmad.

**Results** (eval, Chrome 157):

| | Rolling windows (#2) | With speaker names (3 runs) |
|---|---|---|
| Owners, samples with introductions (remote-intros, malaysian-names) | 3/7 | **7/7 every run** |
| Owners, all samples | 60% | 80–100% |
| Action items found | 100% | 94–100% |
| Recall, all items | 89% | 86–89% |
| Due dates | 94% | 93–100% |
| Made-up text | 0 | 0 |

- **What's left for owners:** blank owners in the final run were in samples with no introductions, where the owner is only named by someone else ("Wei Ming, can you chase them?" answered on the same mic, "Sarah will update …"). `ownerFromTask` fills these when the model keeps the name in the task text; otherwise it shows "—".
- **Prompt order matters:** listing `"I will …"` before `"<name> will …"` cost the portal sample's "Priya will fix them" item in 2 of 2 runs, so the original order was kept.
- **Also fixed:** "Just to confirm, Hafiz, …?" no longer gives the owner "Just".
- **Long-meeting chatter as decisions** (up to 7 extra in one run) is still the noisiest part of the eval; unrelated to names.

- In the live demo, the "So far" card listed Wei Ming as owner of the bank follow-up (blank before), and Q&A answered "Wei Ming (Remote) said they would follow up with the bank".
- **Limit:** names come from what people say, not their voices. Several people on one source share the last name heard until the next introduction.
- **Later:** use voice differences (pitch/energy) to split speakers on one source. Research needed.

### 5. Agenda tracker · ✅ done 2026-11-23
**What was built** (`src/lib/agenda.ts`, `src/ui/agenda-panel.ts`):
- **Agenda tab:** paste or type the agenda (one item per line; bullets and numbers are stripped) and an optional planned length. Items show as not yet, discussed or decided.
- **Checked in the background:** each rolling minutes window also asks the Prompt API which agenda items it discussed or decided (JSON schema of item numbers). Editing the agenda re-checks the windows already drafted, as background work.
- **Grounding (`groundCheck`):** Gemini Nano tends to fill the lists and under-calls "decided", so its answer is checked against what was said:
  - an item only counts as discussed if that stretch shares a word with it;
  - it also counts when one line holds every word of the title ("who signs off UAT?" for "UAT sign-off");
  - a discussed item is decided when a decision or action item from the same stretch shares a word with it.
- **Time box:** while live, "12 min left · 2 items not covered", plus a message at 10 min left and at time up while items are open.
- **Minutes and export:** items nobody got to become open questions ("Agenda item not covered: …"); the Markdown and email export list the agenda with each status.
- **Eval:** three samples have an agenda with expected statuses (`expect.agenda`); "discussed" also accepts "decided". The "not covered" questions are scored under agenda, not as extra open questions.

**Results** (eval, Chrome 157, 14 agenda items in 3 samples):

| | Model only | + grounding | + whole-title line match |
|---|---|---|---|
| Agenda items right | 9/14 (64%) | 13/14 (93%) | 13/14 (93%) |

- **Model only:** it marked items nobody mentioned as discussed ("Staff training", "Office relocation", "Budget for next year"), and missed that "Old portal" and "SSL certificates" were decided.
- **Remaining misses** are discussed-vs-decided calls: "Old VPN" when the extraction missed the VPN decision, or "FPX payment gateway" when its action item ("follow up with the bank") shares no word with the agenda title.
- **In the demo** (Chrome 157): three items were ticked off within a minute of playing it, and "Staff training" stayed open and went into the minutes as an open question. Fixed on the way: the planned-length field rejected 30 (`step=5` from `min=1` allows only 1, 6, 11 …), the Agenda tab wasn't redrawn after Generate minutes, and a past meeting showed "min left".
- **Limit:** an agenda title that shares no words with how people talk about it ("AOB", "Item 3") relies on the model alone.
- **Fixed right after (separate commit):** the extractor sometimes took action items from the EARLIER CONTEXT lines, so the minutes repeated an item ("Wei Ming will follow up with the bank today"). `dropContextItems` now removes an item when a context line covers at least half its words and better than any line in the window; a repeat said inside the window stays. Eval extra items: 12 → 4, recall unchanged within noise. The demo minutes no longer repeat items.
- **Still open:** long-meeting chatter is returned as decisions in some runs (up to 10 in one run).

### 6. Teams / Zoom desktop apps · ✅ done 2026-11-22
Clicking the remote-captions button now asks **"Where is your meeting?"**: in a browser tab, or in the Teams/Zoom app. Each choice explains what to pick in Chrome's share picker, opens the picker on the matching tab (`displaySurface` hint), and is remembered. The desktop-app choice uses an entire-screen share with system audio.
- Verified with fake media in Chrome 157: a screen share (`displaySurface: monitor`) with audio is transcribed and translated like a tab.
- A share with no audio now says what to fix, depending on what was picked. A single window → "share your entire screen instead"; a screen without "Share system audio" ticked → "turn it on"; a tab → "keep tab audio on".
- **Bug fixed on the way:** the Translator was created only after two `availability()` checks, and by then the share picker had used up the click's user activation. A first-time translation download then failed, every caption said "Translation unavailable", and the failure was cached. Translators are now created straight away inside the click, and failures other than "unsupported pair" are retried on the next click.
- **Checked by hand:** a real Teams desktop call with "Share system audio" ticked works.

### 11. Glossary for better captions · ✅ done 2026-11-23
**What was built** (`src/lib/glossary.ts`, `src/ui/glossary-panel.ts`):
- **Names and terms** section in the Agenda tab: add terms separated by commas, remove with ×. Settings has terms for every new meeting. If an earlier meeting has the same title, a button adds its terms.
- **Speaker names** found by introductions or renames are added automatically.
- **Room mic:** Chrome 157 supports `SpeechRecognitionPhrase` hints with on-device recognition (checked: no error, `phrases` accepted). Terms are set on every recognition restart, so edits apply mid-meeting.
- **Remote audio:** each clip's prompt lists the terms, with "do not write any of them unless they are spoken".
- **Correction after the fact:** finished lines are corrected to the listed spelling. Short terms only fix case, spaces and hyphens ("fpx" → "FPX", "red only" → "read-only"); longer ones allow one wrong letter in five with the same first letter ("Muthukumer" → "Muthukumar"). Never across punctuation.
- **Q&A, catch-up and minutes** get the terms in their prompts and Summarizer context.

**Results** (eval sample `misheard-terms`, Chrome 157, 3 runs each):

| | No glossary | With glossary |
|---|---|---|
| Owners right | 1/3 every run | **3/3 every run** |
| Misheard spellings in the minutes | 5 per run | 1 per run |

- **The one left is "gira" for "Jira":** too short to correct safely (it would also turn "city" into "Siti"), and the model copied "gira" despite the terms line. Short names and terms that are misheard with a different first letter still need the user to fix them.
- **In the demo:** typed terms showed as chips, and Kumar, Wei Ming and Ahmad were added as they introduced themselves.
- **Not verified:** whether the Web Speech hints change what is recognised. The fake mic in the test Chrome can't produce a misheard word on demand, so only "accepted without error" was checked.

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
