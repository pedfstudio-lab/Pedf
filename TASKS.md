# DesiPDF — Task Breakdown

Ordered, numbered engineering tasks derived from [ARCHITECTURE.md](ARCHITECTURE.md).
Each task is a self-contained unit of work with a clear "done when". Tasks are sequenced so
each builds on the ones before it. Status: ✅ done · 🔲 not started.

> Discipline (from the architecture): export-seam changes and feature changes never land in the
> same commit; the verification harness must be green before feature work proceeds.

---

## Foundation

### Task 1 — Project scaffold & tooling  ✅
**Goal:** a buildable Vite + React + TypeScript app with the fixed stack.
**Deliverables:** `package.json` (pinned `pdfjs-dist`), `tsconfig*`, `vite.config.ts`, Tailwind v4,
ESLint, `.gitattributes`/`.editorconfig`, `index.html`, `main.tsx`, git repo.
**Done when:** `npm run dev` boots clean and `npm run typecheck` passes.

### Task 2 — PDF load & locked-canvas render (Viewer)  ✅
**Goal:** open a PDF and render each page as an immutable background canvas.
**Deliverables:** `lib/pdf/worker.ts` (`?url` worker), `loadDocument.ts` (pristine-bytes clone),
`renderPage.ts` (renderScale = zoom·dpr), `PageGeometry`, `Toolbar`/`PdfViewer`/`PageCanvas`.
**Depends on:** Task 1.
**Done when:** the sample PDF renders all pages; original bytes are kept separate from pdf.js.

---

## Export seam & verification harness (closes the foundation)

### Task 3 — Edit model & coordinate transform  🔲
**Goal:** the immutable `Edit` contract and the single screen⇄viewport⇄PDF-point conversion module.
**Deliverables:** `lib/export/types.ts` (`Edit = text|cover|image`, `PdfRect`, `EditDocument`);
`lib/export/coordinates.ts` (transform + branded `ScreenPx`/`PdfPt` types); Vitest unit tests
(closed form vs `convertToPdfPoint` across all four rotations).
**Depends on:** Task 2.
**Done when:** transform tests pass for rotations 0/90/180/270; edits store rects in PDF points.

#### Workflow

**What this task is (and isn't).** Pure types + math + tests — no UI, no export, nothing visible on
screen. It builds the two abstractions everything else hangs off of: the immutable `Edit` contract and
the single coordinate module. Inputs from Task 2 already exist: `PageGeometry` (`lib/pdf/types.ts`) and
`renderPage`'s live `viewport` (`lib/pdf/renderPage.ts`).

**Step 1 — Define the Edit model → `src/lib/export/types.ts`** (pure types, zero runtime)

```ts
type Rgb = { r: number; g: number; b: number };          // 0..1
interface PdfRect { x: number; y: number; w: number; h: number; }  // PDF points, bottom-left, UNROTATED

type EditKind = 'text' | 'cover' | 'image';
interface BaseEdit { id: string; kind: EditKind; pageIndex: number; rect: PdfRect; z: number; }

interface TextEdit  extends BaseEdit { kind:'text';  text:string; style:TextStyle; }
interface CoverEdit extends BaseEdit { kind:'cover'; color?:Rgb; sampleBackground:boolean; }
interface ImageEdit extends BaseEdit { kind:'image'; png:Uint8Array; }
type Edit = TextEdit | CoverEdit | ImageEdit;

interface EditDocument {
  readonly originalBytes: Uint8Array;   // pristine — only pdf-lib loads this
  edits: Edit[];
  pages: PageGeometry[];
  sampleBackground?: (pageIndex:number, rect:PdfRect) => Rgb;
}
```

`rect` is always in PDF points; the union is closed (`text|cover|image` only); `originalBytes` is
`readonly`. Task 4's registry keys off `Edit['kind']`, so this file is what makes "adding an edit kind
without a handler is a compile error" possible.

**Step 2 — Coordinate module → `src/lib/export/coordinates.ts`** (the only place conversion happens)

Three spaces: **Screen** (CSS px, top-left, y-down) → **Viewport** (device px, `renderScale = zoom·dpr`,
rotation baked in) → **PDF** (points, bottom-left, y-up, unrotated).

- `screenToViewport(pt, dpr)` / `viewportToScreen(pt, dpr)` — × / ÷ `dpr`.
- `viewportToPdf(viewport, pt)` / `pdfToViewport(...)` — delegate to PDF.js
  `viewport.convertToPdfPoint` / `convertToViewportPoint` (**source of truth**, rotation-correct).
- `screenRectToPdfRect(rect, viewport, dpr)` + inverse — convert the two opposite corners and take
  min/max, so it's robust to the 90°/270° axis swap:

```ts
const a = viewportToPdf(vp, screenToViewport({x:left,       y:top},        dpr));
const b = viewportToPdf(vp, screenToViewport({x:left+width, y:top+height}, dpr));
return { x: Math.min(a.x,b.x), y: Math.min(a.y,b.y), w: Math.abs(a.x-b.x), h: Math.abs(a.y-b.y) };
```

- **Closed-form** rotation formulas (boxOffset 0), exported for tests + as a documented fallback
  (`s = renderScale`, page `W×H` pts):

```
rot 0  : px = vx/s        py = H - vy/s
rot 90 : px = vy/s        py = vx/s
rot 180: px = W - vx/s    py = vy/s
rot 270: px = W - vy/s    py = H - vx/s
```

- Point types are **phantom-branded** (zero runtime cost) so screen px can't be fed to pdf-lib:

```ts
type Tagged<S extends string> = { x:number; y:number; readonly __space?:S };
type ScreenPt = Tagged<'screen'>; type ViewportPt = Tagged<'viewport'>; type PdfPt = Tagged<'pdf'>;
```

**Step 3 — Unit tests → `src/lib/export/coordinates.test.ts`** (Vitest, pure node)

1. **Known mappings** — a specific screen point → a hand-computed PDF point for a concrete page
   (e.g. 595×842 pt at a known scale), checked for all four rotations.
2. **Round-trip identity** — `pdf → screen → pdf ≈ identity` (within epsilon).
3. **dpr-invariance** — the same screen rect yields the same PDF rect at dpr 1/2/3 (dpr cancels because
   S→V multiplies by dpr and V→P divides by `renderScale = zoom·dpr`). Where a `PageViewport` can be
   constructed in node, cross-check closed-form vs `convertToPdfPoint`.

**Step 4 — Verify**

- `npm run typecheck` — `types.ts` + `coordinates.ts` compile under `strict` + `noUncheckedIndexedAccess`.
- `npm run test` — all coordinate tests green (rotations + round-trip + dpr-invariance).
- No dev-server / screenshot check — Task 3 is intentionally invisible; the proof is the passing tests.

**Key decisions & edge cases**

- PDF.js is authoritative at runtime; the closed-form is a tested fallback, not the primary path.
- Rotation 90/180/270 handled via corner min/max + the PDF.js transform.
- `boxOffset` (MediaBox not at origin) is threaded now but only origin-0 pages are exercised;
  **CropBox ≠ MediaBox** stays a documented limitation.
- **dpr cancellation** is asserted, not assumed.

**Commit strategy:** Phase-0 foundation, not a feature — no `Phase N ✓` commit yet; accumulates into
the Phase 0 acceptance commit at Task 7 (an optional local WIP commit is fine).

### Task 4 — Export engine (orchestrator + registry + handlers)  🔲
**Goal:** the stable export seam that patches the original bytes.
**Deliverables:** `registry.ts` (mapped-type `HANDLERS`), `context.ts` (`PageExportContext`),
`exportPdf.ts` (load pristine → group by page → dispatch → save), `handlers/{text,cover,image}.ts`
(image = not-implemented stub), plus structurally-present stubs `englishFont.ts`, `pathA.ts`,
`scriptRouting.ts`, `colorSample.ts`.
**Depends on:** Task 3.
**Done when:** a zero-edit `exportPdf` returns valid bytes; adding an `Edit` kind without a handler
is a compile error.

### Task 5 — Font subsystem scaffolding  🔲
**Goal:** the Noto FontFace loader (used fully in Task 13).
**Deliverables:** `lib/fonts/notoFonts.ts` (`ensureIndicFonts()`, awaits `document.fonts.ready`);
`lib/providers/types.ts` (`LanguageProvider` interface stub).
**Depends on:** Task 1.
**Done when:** fonts load without error when invoked (no visual use yet).

### Task 6 — Verification harness (round-trip)  🔲
**Goal:** dev-only red/green pixel-diff over the real export path.
**Deliverables:** `harness/{roundTrip,runScenario,pixelDiff,VerifyPage}.ts(x)`, `/verify` route behind
`import.meta.env.DEV` + lazy import, `requestAnimationFrame→setTimeout` shim for hidden-pane rendering,
`window.__HARNESS_RESULT__`.
**Depends on:** Task 4.
**Done when:** `/verify` renders a red/green grid and re-runs on demand.

### Task 7 — Phase-0 acceptance + commit  🔲
**Goal:** prove the round-trip is lossless.
**Deliverables:** round-trip ratio < 0.001; structural check (page count/size/rotation unchanged);
export re-opens in pdf.js clean.
**Depends on:** Task 6.
**Done when:** harness green → commit `Phase 0 ✓`.

---

## Text editing

### Task 8 — Text run extraction & hit-testing  🔲
**Goal:** locate tappable text runs and their PDF-point rects.
**Deliverables:** `lib/pdf/textContent.ts` (`getTextContent()` → runs, font size from transform,
bold/italic from font name), positioned via `coordinates.ts`.
**Depends on:** Task 3, Task 7.

### Task 9 — Text edit overlay + controls  🔲
**Goal:** tap a run → contenteditable exactly over the glyphs, with size and width controls.
**Deliverables:** `components/TextEditOverlay.tsx` (A−/A+, width-drag); commit emits a
`CoverEdit{sampleBackground}` + a `TextEdit`; `components/HoldToPeek.tsx`.
**Depends on:** Task 8.

### Task 10 — English export path (font map + cover)  🔲
**Goal:** render English edits with standard fonts and hide the original.
**Deliverables:** `englishFont.ts` mapping table (serif/sans/mono × bold/italic; unknown → warn),
`handlers/text.ts` (English drawText; Indic → Path A stub), `handlers/cover.ts` (mode-color sampling
from the locked raster), export `warnings[]` surfaced as a toast; harness English-edit scenario.
**Depends on:** Task 9. *(Export-path work — separate commit from Task 9.)*
**Done when:** edit one line of a real PDF; layout holds when opened in Adobe Reader on Android.

### Task 11 — Tap popover shell + Search Google  🔲
**Goal:** the shared popover, with the no-AI actions live.
**Deliverables:** `components/TapPopover.tsx` — **Edit** + **Search Google** (`meaning of <selection>`,
new tab, only the selected snippet in the URL); Translate/Meaning slots present but disabled.
**Depends on:** Task 8.

---

## Indic pipeline (Path A)

### Task 12 — Bundle Noto fonts  🔲
**Goal:** ship the shaping fonts.
**Deliverables:** Noto Sans Devanagari + Tamil (Regular/Bold woff2) + OFL.txt in `public/fonts/`.
**Depends on:** Task 5.

### Task 13 — Path A rasterization + routing  🔲
**Goal:** Indic runs export as image patches, never `drawText`.
**Deliverables:** `pathA.ts` (offscreen canvas 3×, HarfBuzz shaping, `embedPng`, drawImage at P-rect),
`scriptRouting.ts` wired (U+0900–097F / U+0B80–0BFF → Path A).
**Depends on:** Task 10, Task 12. *(Export-path work — its own commit.)*

### Task 14 — Indic harness scenarios + acceptance  🔲
**Goal:** prove Indic patches render correctly.
**Deliverables:** `harness/renderReference.ts`; Indic scenarios pixel-compare patch regions
(tolerance < 0.02–0.03).
**Depends on:** Task 13.
**Done when:** `किताब क्षमा हिन्दी श्रद्धा தமிழ்` renders in Android Reader; harness green → commit `Phase 2 ✓`.

---

## Images & tables

### Task 15 — Image selection  🔲
**Goal:** locate existing image regions, or let the user draw one.
**Deliverables:** `lib/pdf/images.ts` (`getOperatorList()` image rects; else user-drawn region).
**Depends on:** Task 7.

### Task 16 — Image edit + handler  🔲
**Goal:** move / resize / delete / insert images.
**Deliverables:** `handlers/image.ts` (`embedPng` + drawImage), `components/ImageOverlay.tsx`
(drag, corner resize, delete, insert PNG/JPG); move/resize = cover old region + re-embed from the
locked raster.
**Depends on:** Task 15. *(Handler is export-path — separate commit from the overlay.)*

### Task 17 — Table column resize  🔲
**Goal:** widen a column via manual guides.
**Deliverables:** `components/TableTool.tsx` (draw region, place vertical guides, drag guide); guide
drag shifts runs with x > guide (text + cover), and redraws ruling lines as thin colored covers.
Composes existing `text` + `cover` kinds only — no export-path change.
**Depends on:** Task 10.
**Done when:** swap an image + widen one table column; export holds → commit `Phase 3 ✓`.

---

## Translate & Meaning

### Task 18 — Provider layer + failover skeleton  🔲
**Goal:** the one interface with deterministic failover.
**Deliverables:** `providers/index.ts` (Sarvam → Anthropic → Browser, silent + logged),
`BhashiniProvider` stub.
**Depends on:** Task 5.

### Task 19 — Sarvam + Anthropic translate/explain  🔲
**Goal:** working translation and plain-language "Meaning".
**Deliverables:** `SarvamProvider.translate()` (Mayura, `api.sarvam.ai/translate`),
`AnthropicProvider.translate()/explain()` (fallback).
**Depends on:** Task 18.

### Task 20 — Settings panel + key storage  🔲
**Goal:** dev-only key entry with the personal-use warning.
**Deliverables:** `providers/keys.ts`, `components/SettingsPanel.tsx` (localStorage, "personal use
only"). Prod uses no client keys (Task 28).
**Depends on:** Task 18.

### Task 21 — Translate/Meaning popover + in-place translate  🔲
**Goal:** replace a block with its translation in place.
**Deliverables:** enable **Translate**/**Meaning** in `TapPopover`; in-place mode emits
`TextEdit`(Indic→Path A) + `CoverEdit`; `prefsStore` persists preferred language.
**Depends on:** Task 13, Task 19.
**Done when:** tap an English paragraph → Hindi in place → exports correctly → commit `Phase 4 ✓`.

---

## Voice discussion

### Task 22 — Document text extraction  🔲
**Goal:** the grounding source for discussion.
**Deliverables:** aggregate `getTextContent()` across pages into a single document-text string.
**Depends on:** Task 2.

### Task 23 — Speech providers  🔲
**Goal:** TTS + ASR with offline fallback.
**Deliverables:** `SarvamProvider.speak()` (Bulbul), `.transcribe()` (Saarika, Hinglish),
`BrowserProvider` (speechSynthesis + Web Speech API).
**Depends on:** Task 18.

### Task 24 — Grounded discuss()  🔲
**Goal:** answers strictly from the document.
**Deliverables:** `AnthropicProvider.discuss()` — document text as sole source; absent info →
"document mein nahin hai."
**Depends on:** Task 22.

### Task 25 — Voice button flow  🔲
**Goal:** end-to-end mic → answer → speech.
**Deliverables:** `components/VoiceButton.tsx` (transcribe → discuss → show + speak).
**Depends on:** Task 23, Task 24.

---

## PWA & deploy

### Task 26 — PWA manifest + service worker  🔲
**Goal:** installable app shell.
**Deliverables:** `vite-plugin-pwa` (injectManifest), manifest, offline shell.
**Depends on:** Task 2.

### Task 27 — Web Share Target  🔲
**Goal:** appear in Android's share sheet for PDFs.
**Deliverables:** manifest `share_target` (POST, multipart, `application/pdf`); SW intercepts the POST,
stages the file, loads it through the normal Loader path.
**Depends on:** Task 26.
**Done when:** share a PDF from WhatsApp → ask by voice → grounded spoken answer → commit `Phase 5 ✓`.

### Task 28 — Cloudflare Worker proxy  🔲
**Goal:** move all secrets server-side.
**Deliverables:** Worker holding Sarvam + Anthropic keys, per-IP rate limiting, translate/tts/asr/discuss
endpoints; provider base-URL switch (dev = direct+localStorage, prod = proxy).
**Depends on:** Task 19, Task 23, Task 24.

### Task 29 — Pages deploy + CI  🔲
**Goal:** auto-deployed public PWA.
**Deliverables:** `wrangler` config for Cloudflare Pages; GitHub Action on push to `main`.
**Depends on:** Task 26.

### Task 30 — Production acceptance  🔲
**Goal:** verify the deploy is safe and functional.
**Deliverables:** pages.dev installs as a PWA; share-target works; **grep the built bundle → no API
key present**.
**Depends on:** Task 28, Task 29.
**Done when:** all three pass → commit `Phase 6 ✓`.
