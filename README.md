# Chrome built-in AI: research, spikes and Meeting Copilot

Experiments with the AI that ships inside Chrome: Gemini Nano and the task APIs built on it (`LanguageModel`, `Summarizer`, `Translator`, `LanguageDetector`). Everything runs on the user's device: no API keys, no server, and transcripts and prompts don't leave the machine.

**Live app:** [meet.h8w.dev](https://meet.h8w.dev), Meeting Copilot, deployed from `main` to Cloudflare Pages.

## What's here

| Folder | What it is |
|---|---|
| [`apps/meeting-copilot/`](apps/meeting-copilot/) | **Meeting Copilot**, a PWA for meetings: translated live captions (room mic and remote speakers from Teams, Zoom or Meet), speaker names, Q&A over the transcript, "catch me up", an agenda tracker, and minutes with action items drafted during the meeting. See its [README](apps/meeting-copilot/README.md) and [ROADMAP](apps/meeting-copilot/ROADMAP.md). |
| [`spikes/`](spikes/) | Eight small single-page experiments: four that use one API each (multilingual inbox, smart form fill, summarize, writing assistant) and four that combine built-in AI with other browser APIs (meeting copilot, voice inspection, screen buddy, language partner). |
| [`docs/research.md`](docs/research.md) | What Chrome's built-in AI is, how it compares with Modern Web Guidance and DevTools AI assistance, API maturity, use cases, and limits found while building (for example, no Malay in the Translator). |

## Requirements

- **Desktop Chrome**, recent: the Prompt API is stable for web pages from Chrome 148; everything here was tested on Chrome 157.
- **Disk:** the first use downloads Gemini Nano (about 4 GB) and needs about 20 GB free.
- **Languages:** the Prompt API writes English, Spanish and Japanese only. The Translator covers many more languages, but not Malay.

## Run locally

Meeting Copilot (Vite, pnpm):

```sh
cd apps/meeting-copilot
pnpm install
pnpm dev          # http://localhost:5174 (add ?demo for a sample meeting)
pnpm test         # unit tests (Vitest)
```

Spikes (plain HTML, no build):

```sh
npx serve spikes  # then open the printed address in desktop Chrome
```

For end-to-end tests in a real Chrome, and for the minutes quality eval, see the [Meeting Copilot README](apps/meeting-copilot/README.md#end-to-end-testing-in-real-chrome). It uses one shared test Chrome profile so the model downloads only once.

## Deploy

Pushes to `main` that change `apps/meeting-copilot/` build and deploy to Cloudflare Pages automatically (project `meeting-copilot`, served at [meet.h8w.dev](https://meet.h8w.dev) and `meeting-copilot-dne.pages.dev`). Other branches get preview addresses. Settings and the security headers are described in the app's [README](apps/meeting-copilot/README.md#deploy-cloudflare-pages).
