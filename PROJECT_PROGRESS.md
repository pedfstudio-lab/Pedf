# DesiPDF — Project Progress

> Living checklist of the full build plan (Phases 0–6) with completed items ticked.
> Full design detail lives in the approved plan; this file tracks **status**.

**Last updated:** 2026-08-16
**Current position:** Task 31's bounded document-edit Undo/Redo history, toolbar controls, and typing-safe shortcuts are implemented and locally verified; a short manual native text-undo check remains. Phase 4 voice work is green through Task 25A, with live Sarvam acceptance still pending.
**Scope change (2026-08-05):** Path A (rendering Hindi/Tamil **into** the PDF) is **removed**. Indian-language support is now **voice-only** — tap any block, hear it explained in your language; the exported PDF stays English. **Phase 2 dropped; Phases 3–6 keep their numbers.**

---

## Legend
- [x] done & verified
- [ ] not started / in progress

---

## Product in one line
Open any PDF in the browser; tap to edit text, add text anywhere, add / replace / delete / crop images, or
**ask about it by voice and hear answers in your language** (Hindi / Tamil / …) — layout never shifts;
download a clean (English) PDF.

## Locked decisions
- [x] Language: **TypeScript** (strict)
- [x] Scope: full plan, all 7 phases
- [x] Sample PDF: user-provided (`public/samples/GOA 2026.pdf` — Goa travel itinerary, 16 pages)
- [x] Stack final: Vite + React + PDF.js + pdf-lib + Tailwind (no substitutions)

## The one architectural idea (the export seam)
UI produces `Edit` objects → export path consumes them through a compile-time-checked handler
registry. Edit geometry stored in **PDF points** (bottom-left, y-up, unrotated) so storage is
zoom/dpr-independent. Edit union stays small all through v1: `text | cover | image`.

---

## Phase 0 — Scaffold, load/render, lossless round-trip, harness  ✅ COMPLETE

### Scaffold & tooling
- [x] `package.json` + `npm install` (clean, exit 0)
- [x] Pin exact `pdfjs-dist@4.10.38`; Vite 6.4, Tailwind 4.3, React 18.3
- [x] `tsconfig.json` / `tsconfig.node.json` (strict, `noUncheckedIndexedAccess`, `@/*` alias)
- [x] `vite.config.ts` (react + tailwind plugins, `base:'./'`, `worker.format:'es'`)
- [x] `eslint.config.js`, `.gitattributes` (LF + binary rules), `.editorconfig`, `.gitignore`
- [x] `index.html`, `src/main.tsx`, `src/index.css` (Tailwind v4 `@import`)
- [x] Typecheck passes (app + node projects)
- [x] `git init` on `main` (identity present)
- [x] `.claude/launch.json` (dev server config)

### Load & render
- [x] `lib/pdf/worker.ts` — PDF.js worker via `?url` import (Windows-safe)
- [x] `lib/pdf/loadDocument.ts` — pristine `originalBytes` clone; pdf.js gets a throwaway copy
- [x] `lib/pdf/types.ts` — `PageGeometry` (unrotated points, rotation, boxOffset)
- [x] `lib/pdf/renderPage.ts` — locked canvas per page, `renderScale = zoom·dpr`, `willReadFrequently`
- [x] `components/` — `Toolbar`, `PdfViewer`, `PageCanvas`, `App`
- [x] Verified: app boots, auto-loads sample, renders all 6 pages (~492k ink pixels page 1)
- [x] Noted env quirk: hidden Browser pane pauses rAF → harness will shim `rAF→setTimeout`

### The export seam (STABLE — never rewritten by features)
- [x] `lib/export/types.ts` — `Edit` union (`text|cover|image`) + `EditDocument`
- [x] `lib/export/coordinates.ts` — screen↔viewport↔PDF-point transforms + branded types
- [x] `lib/export/registry.ts` — mapped-type `{ [K in Edit['kind']]: Handler }` (compile-time exhaustiveness)
- [x] `lib/export/context.ts` — `PageExportContext` factory
- [x] `lib/export/exportPdf.ts` — orchestrator (load pristine bytes → dispatch → save)
- [x] `lib/export/handlers/` — `text.ts`, `cover.ts`, `image.ts` (PNG/JPEG byte embedding)
- [x] `lib/export/englishFont.ts`, `pathA.ts`, `scriptRouting.ts`, `colorSample.ts` (structurally present)
- [x] `lib/fonts/notoFonts.ts` — `ensureIndicFonts()` (FontFace, await `document.fonts.ready`)
- [x] `lib/providers/types.ts` — `LanguageProvider` interface stub
- [x] Unit tests (Vitest): coordinate closed-form vs `convertToPdfPoint`, all 4 rotations

### Verification harness (dev-only `/verify`, tree-shaken from prod)
- [x] `harness/roundTrip.ts` — zero-edit scenario
- [x] `harness/runScenario.ts` — build EditDocument → real `exportPdf` → re-render → pixel-diff
- [x] `harness/pixelDiff.ts` — pixelmatch, force dpr=1, `rAF→setTimeout` shim
- [x] `harness/VerifyPage.tsx` — red/green grid; `window.__HARNESS_RESULT__`
- [x] `routes.tsx` — `/verify` behind `import.meta.env.DEV` + lazy import

### Acceptance
- [x] Round-trip: re-render original vs export, pixelmatch ratio **< 0.001**
- [x] Structural: pdf-lib reopen → equal page count, per-page size & rotation unchanged
- [x] Validity: export re-opens in pdf.js clean
- [x] **Commit `Phase 0 ✓`**

---

## Phase 1 — Text edit (feature 1)  ⏳ IN PROGRESS
- [x] `lib/pdf/textContent.ts` — `getTextContent()` → runs → P-space rects via coordinates
- [x] `components/TextEditOverlay.tsx` — deliberately uncontrolled rich editor per paragraph/block; selection-only B/I; A−/A+ size; font picker; move + width drag
- [x] Commit produces per-line `CoverEdit{sampleBackground}` objects + wrapped `TextEdit` lines
- [x] Task 10C shrink-to-fit implementation completed, then superseded by Task 10D's user-controlled box decision
- [x] Task 10D manual-height/overflow-warning implementation completed, then superseded by Task 10E
- [x] Task 10E final layout — manual width and font size with content-driven auto-height; no warning or hidden text
- [x] Task 10F implementation — the full live editor box uses the sampled page colour with a white fallback; toolbar and handles remain stacked above it
- [x] Whitespace-safe layout preserves repeated spaces, explicit blank lines, and the unwrapped textarea value on re-edit
- [x] Edited visible overlays are tappable to reopen; standalone numeric/short fields remain separate blocks
- [x] English export path: `englishFont.ts` mapping table (serif/sans/mono × bold/italic; warn on substitution)
- [x] `handlers/text.ts` (English drawText; Indic → Path A stub), `handlers/cover.ts` (mode-color sampling)
- [x] Export `warnings[]` shown as toast
- [x] `components/TapPopover.tsx` — block popover is **Edit-only**; Translate/Meaning remain disabled; whole-paragraph Search/Maps removed by Task 11A
- [x] `lib/smart/dateDetect.ts` — named/numeric dates, ranges, and clock times mapped back to precise PDF-run geometry; DD/MM default with ambiguity metadata
- [x] `components/SmartSpanLayer.tsx` + `DateActionPopover.tsx` — reader-mode underlines, editable title, date-order confirmation, Calendar/Reminder/Search actions
- [x] `lib/smart/calendarLink.ts` — pre-filled Google Calendar links with correct all-day exclusive end dates and timed UTC ranges
- [x] `components/HoldToPeek.tsx` — hide overlays to reveal original
- [x] Harness: single English line-edit scenario
- [x] Browser verification: auto-height shows every line; width collapses wraps upward; no warning; A+/A−, whitespace, re-edit, and PDF export hold
- [x] Browser verification: Task 11A finds the sample itinerary's date range/dates/times, renders dotted underlines, opens the correct confirmation menu and Calendar page, keeps block actions Edit-only, and logs no errors
- [x] Task 11B inline rich text — optional bold/italic spans survive wrapping and re-edit, render as selectable multi-run PDF text, and stay on the plain legacy path when the whole box is uniform
- [x] Browser verification: Task 11B character-by-character typing, Backspace, Enter/newline deletion, Done, and PDF export preserve the caret and surrounding text; rich export harness passes at ratio 0.000000
- [x] Task 11C seamless edit sessions — Done without text/style/span/geometry changes creates no edit; short fields open wide enough for the standard font while staying inside the page; serif screen/wrap rendering now uses Times to match export
- [x] Task 11C font classification recognizes common and subset Cambria/Garamond/Minion/Book Antiqua/PT Serif/Merriweather/Noto Serif names instead of falling back to Arial
- [x] Browser verification: Task 11C pristine and pre-existing no-op sessions preserve their source; the Times-based heading stays on one line with zero overlap; real changes still commit; `/verify` remains green
- [x] Task 11D free text — mutually exclusive Add text mode supports drag or click placement, rich formatting, wrapping, cover-free selectable export, peek, and re-editing through grouped standalone text boxes
- [x] Browser verification: Task 11D drag placement, multiline/bold/size editing, mode switching, re-open/update, empty no-op, and export succeeded on GOA 2026; `/verify` remains fully green
- [x] Task 31 implementation — all committed text/cover/image edit batches share a 100-snapshot Undo/Redo history; new edits clear redo and opening a new PDF clears both stacks
- [x] Task 31 automated/UI verification — six reducer cases, 33 test files / 203 tests, typecheck, lint, production build, toolbar buttons, Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y, editable-target history protection, and browser console are green on port 5173
- [ ] Task 31 manual acceptance — confirm Ctrl+Z inside a rich-text field performs native typing undo while leaving document history unchanged
- [ ] Acceptance: edit one line of a real PDF, layout holds in Adobe Reader on Android
- [ ] **Commit `Phase 1 ✓`**

## Phase 2 — ❌ REMOVED (Indic-in-document / Path A, cut 2026-08-05)
Indic **text is no longer rendered into the PDF**. The Indian-language experience is **voice** (see Phase 4/5):
tap → hear it explained in your language; the exported PDF stays English.
- [x] Decision recorded — Path A cut in favour of a spoken explanation
- [ ] Cleanup: delete `pathA.ts`, `scriptRouting.ts`, `lib/fonts/notoFonts.ts`, and the Indic branch in `handlers/text.ts` (pair with Phase 4)

_Cut: Noto font bundling · `pathA.ts` rasterization · `scriptRouting.ts` · Indic harness · the `Phase 2 ✓` gate._

## Phase 3 — Images: add · replace · delete · crop (feature 2)  ⏳ IN PROGRESS
- [x] `lib/pdf/images.ts` — CTM-aware `getOperatorList()` image rectangles; GOA fixture counts verified across all 16 pages
- [x] Task 15B detection precision — painted-canvas colour richness + text signals keep real photos/logos and remove flat text cards; rasterized GOA review screenshots use a dominant-background/text-edge fallback
- [x] Replace and add PNG/JPG with aspect-fit previews and direct original-byte embedding
- [x] `handlers/image.ts` — `embedPng` / `embedJpg` + exact-rect `drawImage`
- [x] `components/ImageOverlay.tsx` — draw/add, pre-confirm move/resize, replace, delete, and crop controls
- [x] Task 16A delete — added images are removed from the edit store; existing images receive an outside-colour cover patch
- [x] Task 16B crop — uploaded bytes crop at source resolution; existing images crop from a fresh 3× PDF.js region capture
- [x] Browser verification on GOA 2026: original-image delete/crop and committed-image crop/delete; Peek and export remain enabled
- [x] Task 15B browser verification on GOA 2026: page 9 review frames 9 → 0; page 8 retains all 10 destination-photo frames; browser console clean
- [x] Unit/build verification: 23 files / 145 tests, typecheck, lint, and production build green
- ❌ ~~Table column resize~~ — **CUT (2026-08-07):** users align tables before sharing (need is rare/self-inflicted); most manual + fiddliest feature; 11D "Add text anywhere" covers the workaround. Recoverable design kept in TASKS.md Task 17.
- [ ] Acceptance: add / replace / delete / crop an image (+ Add-text-anywhere) export cleanly and hold layout
- [ ] **Commit `Phase 3 ✓`**

## Phase 4 — Talk to your PDF: grounded multilingual voice bot  ⏳ IN PROGRESS
> Ask anything about the PDF → answered **grounded in the document, in your chosen language**, then spoken. Build **brain → mouth → ears**. **Sarvam-only.** Translation is **parked** (the bot answers in-language directly).
- [x] Task 18 provider infrastructure — stable `LanguageProvider` facade; capability-aware `SarvamProvider` + `BrowserProvider` shells; deterministic, silent, logged **Sarvam → Browser** failover; direct/proxy config with no embedded key
- [x] Task 18 verification — unsupported methods are skipped, first success wins in order, failures aggregate clearly, and the attempt ring buffer records each hop; 24 test files / 152 tests, lint, typecheck, and production build green
- [x] Task 20 settings — guarded, namespaced dev Sarvam-key storage; persisted supported-language preference; Settings modal with masked set/not-set key state and prominent personal-use warning
- [x] Task 20 browser verification — Hindi and key status survive close/reopen and full reload; Clear restores not-set without exposing the value; production shows the language picker and server-managed-key note only
- [x] Task 20 verification — 26 test files / 159 tests, lint, typecheck, and production build green
- [x] Task 22 — cached, gap-aware `getTextContent()` aggregation across pages with `[Page N]` markers and a 50k-character context guard
- [x] Task 22 verification — page order/real-fixture/known-text/truncation/cache tests; 27 test files / 163 tests, lint, typecheck, and production build green
- [x] **Stage 1 implementation (brain):** `SarvamProvider.discuss({question, documentText, language})` uses the live-tested `sarvam-105b-conversations` model, marker-based grounding, and the key only from `config.getSarvamKey()`; `components/PdfChat.tsx` provides Ask, messages, language selection, thinking/error states, and missing-key guidance
- [x] Task 24 CORS/security verification — key-free preflight permits direct localhost POST + auth/content headers; no dev proxy required; key-like-value scan clean; mocked request/grounding/error tests and browser UI/console checks green
- [x] Task 24 automated verification — 29 test files / 170 tests, lint, typecheck, and production build green
- [x] **Stage 1 live acceptance:** corrected the deprecated model during live testing; GOA itinerary questions now return real grounded answers through Sarvam
- [x] Task 24A implementation — three-mode prompt keeps PDF answers grounded and cited, lets small talk stay natural, and marks outside factual answers as general knowledge; the drawer subtitle and honesty badge explain the distinction
- [x] Task 24A automated/UI verification — focused prompt/provider tests, 29 test files / 170 tests, typecheck, lint, production build, visible labels, and browser console are green
- [ ] **Task 24A live acceptance:** with the key entered in this browser, verify “hi” and “would you like to join?” have no tag, a day-1 stay answer cites the PDF, and Goa weather is labeled “General info — not from this PDF”
- [x] **Task 23 implementation (mouth):** `SarvamProvider.speak()` calls Bulbul v3 with the documented `target_language_code`, decodes WAV bytes, and keeps direct-mode authentication behind `config.getSarvamKey()`; each answer has a race-safe ▶/⏹ control with browser `speechSynthesis` as the UI fallback
- [x] Task 23 automated/UI verification — provider request/auth/error/byte tests, provider-audio cleanup and browser-fallback tests, 30 test files / 178 tests, typecheck, lint, production build, live drawer load, and browser console are green
- [x] Task 23A implementation — `[Page …]` / `[Pages …]` citations remain visible in chat but are stripped only from the shared Sarvam/browser speech input
- [x] Task 23A automated verification — marker/list/range/case tests, 31 test files / 183 tests, typecheck, lint, and production build are green
- [ ] **Task 23A live acceptance:** replay a cited Day-2 answer and confirm its visible page citations are not spoken
- [ ] **Task 23 live acceptance:** with an answer present, hear English and Hindi/Tamil playback; clear the key and confirm ▶ still reads the existing answer through the browser voice
- [x] **Task 25 implementation (ears + loop):** `SarvamProvider.transcribe()` sends boundary-safe multipart WebM/Opus audio through the key-safe provider config; `recordQuestion.ts` captures/releases the mic; `PdfChat` exposes requesting/recording/transcribing states and reuses the grounded ask path with auto-speech only for voice questions
- [x] Task 25 automated/UI verification — STT request/auth/error tests, Sarvam-only capability routing, recorder final-chunk/cancel/empty/permission tests, 32 test files / 193 tests, typecheck, lint, production build, visible production mic control, and browser console are green
- [x] **Task 25A implementation:** the recorder preserves its encoded audio bytes while normalising the final Blob label to the base container MIME (`audio/webm;codecs=opus` → `audio/webm`, with the same handling for MP4) before multipart upload
- [x] Task 25A automated verification — four base-MIME cases plus recorder integration, 32 test files / 197 tests, typecheck, lint, and production build are green
- [ ] **Task 25A live acceptance:** record and stop a real question, confirm Sarvam no longer returns the invalid `audio/webm;codecs=opus` 400, and complete transcript → grounded answer → automatic speech
- [ ] **Task 25 live acceptance:** allow microphone access, ask about the Goa dates, and confirm transcript → grounded answer → automatic speech; repeat with Hindi answer language
- [ ] (optional) Task 21A — AI place/name/event spans → Search / Maps / Meaning (independent reader add-on)
- [ ] Acceptance: ask "what's the check-in time?" → grounded answer; switch to Hindi → same answer in Hindi; ask by voice → spoken Hindi answer
- [ ] **Commit `Phase 4 ✓`**
- ⏸️ **Parked — Translation** ("tap → hear this paragraph translated"): `translate`/`explain` + Listen/Explain popover. Not needed for the core; recoverable (see TASKS.md "Set aside — Translation").

## Phase 5 — PWA + Web Share Target  ⬜ NOT STARTED
> (Voice moved up into Phase 4.) Make it installable and shareable-to.
- [ ] PWA via `vite-plugin-pwa` (injectManifest): manifest + `share_target` (POST, multipart, application/pdf)
- [ ] Custom service worker: intercept share POST → stash PDF → app loads it
- [ ] Acceptance: share a PDF from WhatsApp → it opens in the app (→ ask by voice → grounded spoken answer)
- [ ] **Commit `Phase 5 ✓`**

## Phase 6 — Deploy (Cloudflare Pages + Worker proxy)  ⬜ NOT STARTED
- [ ] `wrangler` config for Cloudflare Pages
- [ ] GitHub Action: auto-deploy on push to `main`
- [ ] Cloudflare Worker proxy: Sarvam + Anthropic keys server-side, per-IP rate limiting
- [ ] Provider base-URL switch: dev = direct+localStorage, prod = proxy (no client keys)
- [ ] Acceptance: pages.dev installs as PWA; share-target works; **grep built bundle → no API key**
- [ ] **Commit `Phase 6 ✓`**

---

## Feature 6 — Smart dates → calendar & places → maps  (reader-layer add-on; NEW)  ⏳ IN PROGRESS
> Reads the document and offers an action; emits **no `Edit`**, never touches the export seam. Fully
> client-side. Slots **after Phase 1** (needs text extraction) and ships **before/with the Phase 6 deploy**.
> Decisions: "Set Reminder" = calendar event with an alarm; calendar = **Add to Google Calendar**.
- [x] Task 11A (supersedes planned Tasks 31–33) — date/time detection, positioned smart spans, confirmation menu, Calendar/Reminder/Search links
- [x] Acceptance: tap the sample's travel-date range → confirm → Google Calendar opens with the right title and dates
- [ ] Task 21A (Phase 4) — AI-backed place/name/event spans with Search/Maps/Meaning

---

## Discipline (enforced throughout)
- [ ] Never modify the export path and a feature in the same commit
- [ ] Never start a phase on a red harness (fix forward within the phase)
- [ ] Commit after every green acceptance test with message `Phase N ✓`

## Dependencies / open items
- [x] Sample PDF provided (`public/samples/GOA 2026.pdf`)
- [ ] Sarvam + Anthropic API keys (needed from Phase 4)
- [x] Confirm Bulbul v3 TTS request/response fields at docs.sarvam.ai (Task 23)
- [x] Confirm Saaras v3 STT request/response fields at docs.sarvam.ai (Task 25)
