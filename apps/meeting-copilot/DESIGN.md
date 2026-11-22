# Design direction: Meeting Copilot

**Goal:** feel like a first-party Google Workspace tool, closest to Google Meet's side panels and Gmail's chrome, while staying clearly *our* product. We use the open Material 3 design language, the open-source **Google Sans Flex** font and **Material Symbols** icons. We do **not** use Google logos, product names or Meet's exact layouts and illustrations.

## Principles

1. **Calm surfaces, one accent.** Large areas of tonal neutral surface, with colour reserved for the primary action, active state and speaker identity. No borders on cards: separation comes from tonal surface steps (M3 "surface container" levels).
2. **Captions are the stage.** The live captions pane is the biggest, highest-contrast area, with large type and generous line height, like a caption track. Everything else is supporting chrome.
3. **Controls live at the bottom.** As in a call, the capture controls sit in a centred bottom bar of round, tonal icon buttons, with a red pill to end. They stay in the same place on every screen size.
4. **Show state, not text.** Recording, privacy (on-device vs cloud) and model download are shown with icons, chips and a progress bar. Status sentences go into a snackbar, not a permanent red line.
5. **Respect the user's system.** Follow the OS light/dark setting by default. The override lives in **Settings → Appearance** (System / Light / Dark), as in Google's own apps, not in a permanent header switch.

## Tokens

Colour roles follow the Material 3 baseline used across Google Workspace. All are defined once with `light-dark()` in `src/styles/tokens.css`.

| Role | Light | Dark | Used for |
|---|---|---|---|
| `--surface` | `#F8FAFD` | `#131314` | page background |
| `--surface-container-low` | `#F0F4F9` | `#1B1B1C` | top app bar on scroll, list rows |
| `--surface-container` | `#E9EEF6` | `#1E1F20` | cards, side panel |
| `--surface-container-high` | `#DDE3EA` | `#282A2C` | inputs, chips, hovered rows |
| `--surface-bright` (stage) | `#FFFFFF` | `#0E0E0F` | captions stage |
| `--on-surface` | `#1F1F1F` | `#E3E3E3` | body text |
| `--on-surface-variant` | `#444746` | `#C4C7C5` | secondary text, icons |
| `--outline` | `#747775` | `#8E918F` | input outlines (3:1) |
| `--outline-variant` | `#C4C7C5` | `#444746` | dividers |
| `--primary` | `#0B57D0` | `#A8C7FA` | primary buttons, links, focus ring |
| `--on-primary` | `#FFFFFF` | `#062E6F` | text on primary |
| `--primary-container` | `#D3E3FD` | `#0842A0` | active tonal buttons, selected chip |
| `--on-primary-container` | `#041E49` | `#D3E3FD` | |
| `--secondary-container` | `#C2E7FF` | `#004A77` | tonal buttons, Room speaker |
| `--tertiary-container` | `#C4EED0` | `#0F5223` | success, "on-device" chip |
| `--remote` / container | `#7438D2` / `#EADDFF` | `#D0BCFF` / `#4A2A8A` | Remote speaker identity |
| `--error` / container | `#B3261E` / `#F9DEDC` | `#F2B8B5` / `#8C1D18` | End button, errors |

**Type:** Google Sans Flex, self-hosted (`@fontsource-variable/google-sans-flex`), falling back to Roboto, Segoe UI and system-ui. The scale is loosely M3 and uses `rem`:

| Token | Size / weight | Use |
|---|---|---|
| display-s | 2.25rem / 400 | empty-state heading |
| headline-s | 1.5rem / 400 | page title (meeting name) |
| title-l | 1.375rem / 400 | app bar title |
| title-m | 1rem / 500 | panel headings, list item title |
| body-l | 1rem / 400 | body |
| body-m | 0.875rem / 400 | supporting text |
| label-l | 0.875rem / 500 | buttons, chips |
| caption | clamp(1.25rem, 1rem + 0.8vw, 1.75rem) / 400 | live captions |

**Shape:** full-pill buttons, chips and search (`999px`); cards and panels 28px (M3 extra-large); dialog 28px; inputs and menus 16px; small items 8px.

**Elevation:** tonal only. The single shadow is on the floating bottom bar and the snackbar (M3 level 2).

**Motion:** M3 "emphasized decelerate" `cubic-bezier(0.05, 0.7, 0.1, 1)`, 200–350 ms. State layers (hover 8%, press 12% of the content colour) via `color-mix()`. View transitions between screens. All motion is off under `prefers-reduced-motion`.

**Icons:** Material Symbols **Rounded**, weight 400, 24px. Rendered through the CSS icon engine (`--icon-*` tokens as mask data URIs), so icons follow `currentColor` and can be swapped from CSS by state (e.g. `mic` → `mic_off`).

## Screens

### Top app bar (all screens)
`[logo mark] Meeting Copilot` · (history: pill search field, Gmail-style) · `Install` text button (only when installable) · `Settings` icon button.

### History
- Empty state: an illustration-free heading ("Meetings, captioned on your device"), one line of explanation, and a filled **New meeting** button.
- List: rows on `surface-container-low`, each with a leading round icon, the title, supporting text (date · duration · lines) and trailing chips ("3 action items" in tertiary, or "No minutes"). Delete is an icon button that appears on row hover or focus and is always visible on touch.

### Meeting
- App bar: back arrow, editable title (looks like plain text until hover or focus), date as supporting text.
- **Banner** (M3) at the top only when built-in AI is unavailable, with what's affected and an action ("How to fix"). It replaces the red status line.
- **Stage** (left, ~60%): captions. Each line has a speaker chip (Room = secondary colour, Remote = purple, with a leading icon), the translated text in caption type, and the original in body-m on-surface-variant. A "Jump to live" chip floats at the bottom when scrolled up.
- **Side panel** (right, ~40%, `surface-container`, radius 28): two tabs, **Ask** and **Minutes**, each with an icon.
  - Ask: "Catch me up" suggestion chips (2 / 5 / 10 min), a pill question field with a send icon button, and answers as cards with a ✦ (auto_awesome) mark, like AI answers in Google products.
  - Minutes: "Generate minutes" tonal button, sections with title-m headings, the action-item table, and an export row of tonal icon+label buttons.
- **Bottom bar** (fixed, centred, floating pill on `surface-container-high`):
  - left: language chip `English → 中文` (opens a menu with both selects);
  - centre: round buttons, **Mic** (Room), **Present** (tab audio), **Float captions**, plus **Demo** in demo mode. Active capture = primary-container fill with a pulsing red dot;
  - right: privacy chip (🔒 on-device / ☁️ cloud) and a red **End** pill that stops capture and opens Minutes.
- **Snackbar** for transient status ("Listening to the room", "Minutes ready · 4 action items"); errors use the banner or an inline error.

### Settings dialog (M3 full-width dialog)
- **Appearance:** a three-state segmented button — System (shows "currently dark"), Light, Dark.
- **On-device AI:** live availability list for Prompt API, Summarizer, Translator and speech, with state chips, plus a link to `chrome://on-device-internals` shown as copyable text (pages can't link to chrome:// URLs).
- **Default languages:** spoken and caption language for new meetings.

### Floating captions (Document PiP)
Black stage (`#000` / `#fff` text whatever the theme, like caption tracks), caption type at 1.4rem, speaker colours kept, no chrome.

## Accessibility guardrails
- Text 4.5:1 and UI boundaries 3:1 in both themes. Focus ring: 2px `--primary` with a 2px offset on every interactive element (`:focus-visible`).
- Speaker identity is never colour-only: the chip has a text label and an icon.
- Bottom-bar buttons are at least 48px with `aria-pressed` and tooltips (title plus visible label below on wide screens).
- Live regions: captions `aria-live=polite` (lines, not interim text); the snackbar is `role=status`.
