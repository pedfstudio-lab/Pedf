# DesiPDF — Project Progress

> Living checklist of the full build plan (Phases 0–6) with completed items ticked.
> Full design detail lives in the approved plan; this file tracks **status**.

**Last updated:** 2026-08-02
**Current position:** Phase 1 in progress — Tasks 9–10E complete; Task 11 tap popover next. Real-device PDF acceptance remains pending.

---

## Legend
- [x] done & verified
- [ ] not started / in progress

---

## Product in one line
Open any PDF in the browser; tap to edit text, manipulate images, widen table columns,
translate to Indian languages, or discuss the document by voice — layout never shifts;
download a clean PDF.

## Locked decisions
- [x] Language: **TypeScript** (strict)
- [x] Scope: full plan, all 7 phases
- [x] Sample PDF: user-provided (`public/samples/sample-basic.pdf` — Firgun travel itinerary, 6 pages)
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
- [x] `lib/export/handlers/` — `text.ts`, `cover.ts`, `image.ts` (image = not-implemented stub)
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
- [x] `components/TextEditOverlay.tsx` — one native textarea per paragraph/block; A−/A+ size; B/I toggles; font picker; move + width drag
- [x] Commit produces per-line `CoverEdit{sampleBackground}` objects + wrapped `TextEdit` lines
- [x] Task 10C shrink-to-fit implementation completed, then superseded by Task 10D's user-controlled box decision
- [x] Task 10D manual-height/overflow-warning implementation completed, then superseded by Task 10E
- [x] Task 10E final layout — manual width and font size with content-driven auto-height; no warning or hidden text
- [x] Whitespace-safe layout preserves repeated spaces, explicit blank lines, and the unwrapped textarea value on re-edit
- [x] Edited visible overlays are tappable to reopen; standalone numeric/short fields remain separate blocks
- [x] English export path: `englishFont.ts` mapping table (serif/sans/mono × bold/italic; warn on substitution)
- [x] `handlers/text.ts` (English drawText; Indic → Path A stub), `handlers/cover.ts` (mode-color sampling)
- [x] Export `warnings[]` shown as toast
- [ ] `components/TapPopover.tsx` — shell + **Edit** + **Search Google** (`meaning of <selection>`) + **Open in Maps** (place names); Translate/Meaning disabled
- [x] `components/HoldToPeek.tsx` — hide overlays to reveal original
- [x] Harness: single English line-edit scenario
- [x] Browser verification: auto-height shows every line; width collapses wraps upward; no warning; A+/A−, whitespace, re-edit, and PDF export hold
- [ ] Acceptance: edit one line of a real PDF, layout holds in Adobe Reader on Android
- [ ] **Commit `Phase 1 ✓`**

## Phase 2 — Indic pipeline (Path A) + harness green  ⬜ NOT STARTED
- [ ] Bundle Noto Sans Devanagari + Tamil (Regular/Bold woff2) + OFL.txt in `public/fonts/`
- [ ] `pathA.ts` full: offscreen canvas 3×, HarfBuzz shaping, `embedPng`, drawImage at P-rect
- [ ] `scriptRouting.ts` wired: U+0900–097F / U+0B80–0BFF → Path A; never `drawText`
- [ ] `harness/renderReference.ts` — native canvas render of a string
- [ ] Indic scenarios pixel-compare patch region (tolerance < 0.02–0.03)
- [ ] Acceptance: `किताब क्षमा हिन्दी श्रद्धा தமிழ்` renders in Android Reader; harness green
- [ ] **Commit `Phase 2 ✓`**

## Phase 3 — Images + table column resize (features 2, 3)  ⬜ NOT STARTED
- [ ] `lib/pdf/images.ts` — `getOperatorList()` image rects, else user-drawn region
- [ ] Image move/resize/delete (cover + re-embed from locked raster); insert PNG/JPG
- [ ] `handlers/image.ts` — `embedPng` + drawImage
- [ ] `components/ImageOverlay.tsx` — drag, corner resize, delete, insert
- [ ] `components/TableTool.tsx` — draw region, place vertical guides, drag guide
- [ ] Guide drag: shift runs (x > guide) as text+cover; redraw ruling lines as thin colored covers
- [ ] Acceptance: swap an image + widen one table column; layout holds
- [ ] **Commit `Phase 3 ✓`**

## Phase 4 — Translate + Meaning popover + in-place translate (feature 4)  ⬜ NOT STARTED
- [ ] `providers/` — `SarvamProvider.translate()` (Mayura, `api.sarvam.ai/translate`)
- [ ] `AnthropicProvider.translate()/explain()` (fallback + Meaning)
- [ ] `providers/index.ts` failover Sarvam → Anthropic → Browser (silent, logged)
- [ ] `BhashiniProvider` stub (TODO, non-blocking)
- [ ] `providers/keys.ts` + `SettingsPanel.tsx` — dev-only localStorage keys + "personal use only" warning
- [ ] TapPopover: enable **Translate** + **Meaning**
- [ ] In-place mode: translation → `TextEdit`(Indic→Path A) + `CoverEdit`
- [ ] `prefsStore` — preferred language persisted
- [ ] Acceptance: tap English para → Hindi in place → exports correctly
- [ ] **Commit `Phase 4 ✓`**

## Phase 5 — Voice discussion (feature 5) + PWA share-target  ⬜ NOT STARTED
- [ ] `SarvamProvider.speak()` (Bulbul TTS), `.transcribe()` (Saarika ASR, Hinglish)
- [ ] `AnthropicProvider.discuss()` — document-grounded; else "document mein nahin hai."
- [ ] `BrowserProvider` — speechSynthesis TTS + Web Speech API ASR
- [ ] `components/VoiceButton.tsx` — mic → transcribe → discuss → show + speak
- [ ] PWA via `vite-plugin-pwa` (injectManifest): manifest + `share_target` (POST, multipart, application/pdf)
- [ ] Custom service worker: intercept share POST → stash PDF → app loads it
- [ ] Acceptance: share PDF from WhatsApp → ask by voice → grounded spoken answer
- [ ] **Commit `Phase 5 ✓`**

## Phase 6 — Deploy (Cloudflare Pages + Worker proxy)  ⬜ NOT STARTED
- [ ] `wrangler` config for Cloudflare Pages
- [ ] GitHub Action: auto-deploy on push to `main`
- [ ] Cloudflare Worker proxy: Sarvam + Anthropic keys server-side, per-IP rate limiting
- [ ] Provider base-URL switch: dev = direct+localStorage, prod = proxy (no client keys)
- [ ] Acceptance: pages.dev installs as PWA; share-target works; **grep built bundle → no API key**
- [ ] **Commit `Phase 6 ✓`**

---

## Feature 6 — Smart dates → calendar & places → maps  (reader-layer add-on; NEW)  ⬜ NOT STARTED
> Reads the document and offers an action; emits **no `Edit`**, never touches the export seam. Fully
> client-side. Slots **after Phase 1** (needs text extraction) and ships **before/with the Phase 6 deploy**.
> Decisions: "Set Reminder" = calendar event with an alarm; calendar = **Add to Google Calendar**.
- [ ] Places → Maps: **Open in Maps** folded into `TapPopover` (Phase 1) — `google.com/maps/search`
- [ ] Task 31 — `lib/smart/dateDetect.ts`: detect dates/times + positions from `getTextContent()` (DD/MM default)
- [ ] Task 32 — `components/SmartSpanLayer.tsx` + `DateActionPopover.tsx`: tappable date highlights + confirm (title + DD/MM toggle)
- [ ] Task 33 — `lib/smart/calendarLink.ts`: **Add to Google Calendar** (`render?action=TEMPLATE`); **Set Reminder** = event + Google default alarm; optional `.ics`+`VALARM` fallback
- [ ] Acceptance: tap a date in the sample PDF → confirm → Google Calendar opens pre-filled

---

## Discipline (enforced throughout)
- [ ] Never modify the export path and a feature in the same commit
- [ ] Never start a phase on a red harness (fix forward within the phase)
- [ ] Commit after every green acceptance test with message `Phase N ✓`

## Dependencies / open items
- [x] Sample PDF provided (`public/samples/sample-basic.pdf`)
- [ ] Sarvam + Anthropic API keys (needed from Phase 4)
- [ ] Confirm Bulbul (TTS) / Saarika (ASR) request field shapes at docs.sarvam.ai (Phase 5)
