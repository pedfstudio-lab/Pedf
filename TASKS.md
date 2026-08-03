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

### Task 3 — Edit model & coordinate transform  ✅
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

### Task 4 — Export engine (orchestrator + registry + handlers)  ✅
**Goal:** the stable export seam that patches the original bytes.
**Deliverables:** `registry.ts` (mapped-type `HANDLERS`), `context.ts` (`PageExportContext`),
`exportPdf.ts` (load pristine → group by page → dispatch → save), `handlers/{text,cover,image}.ts`
(image = not-implemented stub), plus structurally-present stubs `englishFont.ts`, `pathA.ts`,
`scriptRouting.ts`, `colorSample.ts`.
**Depends on:** Task 3.
**Done when:** a zero-edit `exportPdf` returns valid bytes; adding an `Edit` kind without a handler
is a compile error.

#### Workflow

**What this task is (and isn't).** Builds the **stable export seam** — the dumb orchestrator + the
compile-checked handler registry + the per-page context — on top of Task 3's `types.ts` /
`coordinates.ts`. It ships exactly **one real handler (`cover`)**; `text` and `image` are guarded stubs
whose real bodies belong to later tasks (English path → Task 10, Path A → Task 13, image embed →
Task 16). No UI. This file set must never be reopened to add a feature.

**Step 1 — Utilities → `src/lib/util/{assert,groupBy}.ts`**

```ts
// assert.ts
export function assertNever(x: never, msg = 'unexpected variant'): never { throw new Error(`${msg}: ${JSON.stringify(x)}`); }
export function invariant(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(`Invariant failed: ${msg}`); }
export function notImplemented(feature: string): never { throw new Error(`Not implemented yet: ${feature}`); }

// groupBy.ts
export function groupBy<T, K>(items: readonly T[], key: (t: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) { const k = key(item); const a = map.get(k); a ? a.push(item) : map.set(k, [item]); }
  return map;
}
```

**Step 2 — Per-page context → `src/lib/export/context.ts`**

Carries everything a handler is allowed to touch — and nothing else (no `save`, no DOM, no coordinate
math beyond consuming an already-PDF-point `rect`).

```ts
export interface PageExportContext {
  pdf: PDFDocument; page: PDFPage; geometry: PageGeometry; warnings: string[];
  drawRect(rect: PdfRect, color: Rgb): void;         // → page.drawRectangle, Rgb 0..1 → rgb()
  sampleBackground(rect: PdfRect): Rgb | undefined;  // delegates to doc.sampleBackground?
}
export function makePageContext(args: { pdf; page; geometry; doc; warnings }): PageExportContext { /* ... */ }
```

`PdfRect` is already absolute PDF user space (bottom-left) = pdf-lib's draw space, so `drawRect` is just
`{ x, y, width: w, height: h }` — no offset math. Page `/Rotate` is applied by the viewer and glyph
bboxes are axis-aligned in unrotated space, so cover rects need no rotation handling yet.

**Step 3 — Handlers → `src/lib/export/handlers/{cover,text,image}.ts`**

```ts
// cover.ts — the one REAL handler (foundational primitive: text/table/translate/image-delete all use it)
const WHITE: Rgb = { r: 1, g: 1, b: 1 };
export const drawCover: EditHandler<CoverEdit> = (edit, ctx) => {
  const color = edit.color ?? (edit.sampleBackground ? ctx.sampleBackground(edit.rect) : undefined) ?? WHITE;
  ctx.drawRect(edit.rect, color);
};

// text.ts — routing seam, guarded stub
export const drawText: EditHandler<TextEdit> = (edit) =>
  notImplemented(isIndicRun(edit.text) ? 'Indic text export / Path A (Task 13)' : 'English text export (Task 10)');

// image.ts — guarded stub
export const drawImage: EditHandler<ImageEdit> = () => notImplemented('image export (Task 16)');
```

**Step 4 — Routing + helper stubs**

```ts
// scriptRouting.ts — REAL (trivial + correct)
export const INDIC = /[ऀ-ॿ஀-௿]/;
export const isIndicRun = (text: string): boolean => INDIC.test(text);
```

`englishFont.ts` (Task 10), `pathA.ts` (Task 13), `colorSample.ts` (Task 10) — minimal typed stubs with
a TODO + `notImplemented`, so their owning tasks fill them in place without touching the seam.

**Step 5 — Registry → `src/lib/export/registry.ts`** (the compile-time exhaustiveness gate)

```ts
export type EditHandler<E extends Edit = Edit> = (edit: E, ctx: PageExportContext) => void | Promise<void>;
export const HANDLERS: { [K in Edit['kind']]: EditHandler<Extract<Edit, { kind: K }>> } = {
  text: drawText, cover: drawCover, image: drawImage,
};
```

**Step 6 — Orchestrator → `src/lib/export/exportPdf.ts`** (deliberately dumb + stable)

```ts
export interface ExportResult { bytes: Uint8Array; warnings: string[]; }
export async function exportPdf(doc: EditDocument): Promise<ExportResult> {
  const pdf = await PDFDocument.load(doc.originalBytes, { updateMetadata: false }); // pristine
  const warnings: string[] = [];
  for (const [pageIndex, edits] of groupBy(doc.edits, e => e.pageIndex)) {
    const page = pdf.getPage(pageIndex);
    const geometry = doc.pages[pageIndex];
    invariant(geometry, `missing geometry for page ${pageIndex}`);
    const ctx = makePageContext({ pdf, page, geometry, doc, warnings });
    for (const e of [...edits].sort((a, b) => a.z - b.z)) await (HANDLERS[e.kind] as EditHandler)(e, ctx);
  }
  return { bytes: await pdf.save(), warnings };
}
```

**Step 7 — Verification test → `src/lib/export/exportPdf.test.ts`** (Vitest, node, self-contained)

Build the input with pdf-lib (2 pages), then assert:
1. **zero edits** → output starts with `%PDF-`, reloads in pdf-lib, page count + per-page sizes unchanged.
2. **one `CoverEdit`** → reloads valid, page count unchanged (dispatch + draw works end-to-end).
3. **a `TextEdit`** → `exportPdf(...)` rejects with `/Not implemented/` (documents the stub boundary).

Compile-time exhaustiveness needs no runtime test — the mapped type enforces it.

**Step 8 — Verify**

- `npm run test` — existing 16 coordinate tests still green + the new export tests pass.
- `npm run typecheck` — compiles under strict + `noUncheckedIndexedAccess`; deleting a `HANDLERS` entry
  must fail to compile (spot-check).
- `npm run lint` — clean. No dev-server/visual check (no UI yet).

**Key decisions**

- **`cover` is the only real handler**; `text`/`image` are honest guarded stubs — keeps English-path
  (Task 10), Path A (Task 13), and image (Task 16) out of this commit.
- **`PdfRect` draws directly** into pdf-lib (same absolute user space) — no offset/rotation math here.
- **`load(..., { updateMetadata: false })`** so pdf-lib doesn't inject ModDate/Producer before the
  output is saved (cleaner round-trip; in pdf-lib 1.17 this is a load option, not a save option).

**Commit strategy:** Phase-0 foundation, not a feature — no `Phase N ✓` commit yet; accumulates into the
Phase 0 acceptance commit at Task 7 (optional local WIP commit).

### Task 5 — Font subsystem scaffolding  ✅
**Goal:** the Noto FontFace loader (used fully in Task 13).
**Deliverables:** `lib/fonts/notoFonts.ts` (`ensureIndicFonts()`, awaits `document.fonts.ready`);
`lib/providers/types.ts` (`LanguageProvider` interface stub).
**Depends on:** Task 1.
**Done when:** `notoFonts.ts` + `providers/types.ts` compile and lint; `ensureIndicFonts()` is
memoized/idempotent and safely no-ops outside a browser (unit-tested with a stubbed `FontFace`). Real
font *files* (Task 12) and runtime shaping (Task 13) are out of scope.

#### Workflow

**What this task is (and isn't).** Pure scaffolding — two cross-cutting modules created early so later
tasks fill bodies in place, never touching the seam. **No UI, no feature behaviour.** Note the font
*files* (`.woff2`) are bundled in **Task 12** and the loader is first *called* in **Task 13** (Path A);
so here we build the **loader function and the provider contract**, not a working end-to-end font render.

**Step 1 — Noto FontFace loader → `src/lib/fonts/notoFonts.ts`**

Establishes the family-name constants Path A will use in its canvas `font` string, and a memoized,
browser-guarded loader that awaits font readiness before any offscreen shaping.

```ts
export const NOTO_DEVANAGARI = 'Noto Sans Devanagari';
export const NOTO_TAMIL = 'Noto Sans Tamil';

const FONT_DEFS = [
  { family: NOTO_DEVANAGARI, weight: '400', file: 'NotoSansDevanagari-Regular.woff2' },
  { family: NOTO_DEVANAGARI, weight: '700', file: 'NotoSansDevanagari-Bold.woff2' },
  { family: NOTO_TAMIL,      weight: '400', file: 'NotoSansTamil-Regular.woff2' },
  { family: NOTO_TAMIL,      weight: '700', file: 'NotoSansTamil-Bold.woff2' },
] as const;

let pending: Promise<void> | null = null;                       // memoize: load at most once

export function ensureIndicFonts(): Promise<void> {
  return (pending ??= loadAll());
}

async function loadAll(): Promise<void> {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return; // SSR/node guard
  await Promise.all(FONT_DEFS.map(async (d) => {
    const face = new FontFace(d.family, `url(${import.meta.env.BASE_URL}fonts/${d.file})`,
      { weight: d.weight, style: 'normal', display: 'swap' });
    await face.load();
    document.fonts.add(face);
  }));
  await document.fonts.ready;                                   // MUST await before measure/fillText
}
```

Why each choice: **memoized promise** (fonts load once even if Path A calls it per-run); **browser
guard** (so importing the module in node/tests/SSR can't throw); **`import.meta.env.BASE_URL`** (survives
a non-root deploy in Phase 6); **`await document.fonts.ready`** (skip it and the first offscreen render
measures a fallback → tofu boxes).

**Step 2 — Provider contract → `src/lib/providers/types.ts`**

The single interface all AI I/O goes through (implemented across Tasks 18–25). Types + interface only,
zero runtime.

```ts
export type LanguageCode = string;  // BCP-47 'xx-IN' (e.g. 'hi-IN', 'ta-IN', 'en-IN'); 'auto' allowed

export interface TranslateInput  { text: string; to: LanguageCode; from?: LanguageCode; }
export interface ExplainInput    { text: string; language: LanguageCode; }
export interface SpeakInput      { text: string; language: LanguageCode; voice?: string; }
export interface TranscribeInput { audio: Blob;  language?: LanguageCode; }
export interface DiscussInput    { question: string; documentText: string; language?: LanguageCode; }

export interface TextResult    { text: string; provider: string; }
export interface SpeakResult   { audio: Blob;  provider: string; }
export interface DiscussResult { answer: string; grounded: boolean; provider: string; }

/** All AI passes through this one seam; concrete providers are added in later tasks. */
export interface LanguageProvider {
  readonly name: string;
  translate(input: TranslateInput): Promise<TextResult>;
  explain(input: ExplainInput): Promise<TextResult>;
  speak(input: SpeakInput): Promise<SpeakResult>;
  transcribe(input: TranscribeInput): Promise<TextResult>;
  discuss(input: DiscussInput): Promise<DiscussResult>;
}
```

Signatures may be lightly refined when the first concrete provider lands (Task 19), but the five-verb
shape and the `grounded` flag on `discuss` (for the "document mein nahin hai" guarantee) are fixed now.

**Step 3 — Unit test → `src/lib/fonts/notoFonts.test.ts`** (Vitest, node, stubbed globals)

Node has no `FontFace`/`document.fonts`, so stub them with `vi.stubGlobal` + `vi.resetModules()` between
cases and assert:
1. **memoized** — two `ensureIndicFonts()` calls trigger exactly one load pass.
2. **registers 4 faces** — Devanagari + Tamil × Regular + Bold, with correct family/weight and a
   `fonts/…` URL.
3. **awaits readiness** — `document.fonts.ready` is awaited before resolving.
4. **non-browser no-op** — with globals unset, it resolves without throwing.

`providers/types.ts` needs no runtime test — typecheck covers it.

**Step 4 — Verify**

- `npm run test` — existing 19 tests stay green + the 4 font-loader tests pass.
- `npm run typecheck` — both modules compile under strict.
- `npm run lint` — clean. `npm run build` — succeeds (loader tree-shakes; it's unused until Task 13).
- No dev-server/visual check.

**Key decisions & edge cases**

- **Loader ≠ files.** The `.woff2` files land in Task 12; until then `ensureIndicFonts()` would reject at
  runtime if actually invoked — which nothing does yet. Scaffolding by design.
- **Family names are a contract** with Path A (Task 13): the strings here must match its canvas `font`.
- **No test-only exports in prod code** — the loader's memo is reset in tests via `vi.resetModules()`.

**Commit strategy:** Phase-0 foundation — no `Phase N ✓` commit; folds into the Task 7 acceptance commit.

### Task 6 — Verification harness (round-trip)  ✅
**Goal:** dev-only red/green pixel-diff over the real export path.
**Deliverables:** `harness/{roundTrip,runScenario,pixelDiff,VerifyPage}.ts(x)`, `/verify` route behind
`import.meta.env.DEV` + lazy import, `requestAnimationFrame→setTimeout` shim for hidden-pane rendering,
`window.__HARNESS_RESULT__`.
**Depends on:** Task 4.
**Done when:** `/verify` renders a red/green grid and re-runs on demand.

#### Workflow

**What this task is (and isn't).** The first *visible* milestone and Phase 0's gate. A DEV-only `/verify`
page runs scenarios through the **real `exportPdf`** (Task 4), re-renders with PDF.js, pixel-compares
against an expected render, and shows a **red/green** grid. Not a unit test — it exercises the whole
render→export→re-render pipeline. Single scenario now (zero-edit round-trip); Tasks 10/14 add more.

**Step 1 — Hidden-pane render shim → `src/harness/env.ts`**
```ts
// DEV/harness only. PDF.js drives rendering with requestAnimationFrame, which browsers PAUSE when the
// pane isn't compositing — so headless/hidden runs stall. Route rAF through setTimeout.
export function installHiddenRenderShim(): void {
  window.requestAnimationFrame = (cb) =>
    window.setTimeout(() => cb(performance.now()), 0) as unknown as number;
}
```
Imported only by the harness (dev, lazy) — never by the app or prod.

**Step 2 — Deterministic PDF→pixels → `src/harness/renderPdf.ts`**
Render bytes with the shared pdf.js (`@/lib/pdf/worker`) at a fixed scale with **dpr forced to 1** (so
diffs reproduce across machines), one `ImageData` per page.
```ts
export async function renderPdfToImageData(bytes: Uint8Array, scale = 1.5): Promise<ImageData[]> {
  // getDocument({ data: bytes.slice() }) → per page: size a canvas to the scale-`scale` viewport,
  // render, ctx.getImageData(0,0,w,h). No devicePixelRatio.
}
```

**Step 3 — Pixel compare → `src/harness/pixelDiff.ts`** (pixelmatch v6, default import)
```ts
import pixelmatch from 'pixelmatch';
export interface DiffResult { ratio: number; diff: ImageData; }
export function diffImageData(expected: ImageData, actual: ImageData): DiffResult {
  if (expected.width !== actual.width || expected.height !== actual.height) return { ratio: 1, diff: expected };
  const { width, height } = expected;
  const diff = new ImageData(width, height);
  const mismatched = pixelmatch(expected.data, actual.data, diff.data, width, height, { threshold: 0.1 });
  return { ratio: mismatched / (width * height), diff };
}
```
Optional Vitest test (node): call `pixelmatch` on raw `Uint8ClampedArray`s (identical → 0 mismatches; one
flipped pixel → >0). Node has no `ImageData`, so test at the pixelmatch level, not `diffImageData`.

**Step 4 — Scenario pipeline → `src/harness/runScenario.ts`**
```ts
export interface Scenario { name: string; tolerance: number; setup(): Promise<{ doc: EditDocument; expectedBytes: Uint8Array }>; }
export interface PageResult { pageIndex: number; ratio: number; expected: ImageData; actual: ImageData; diff: ImageData; }
export interface ScenarioResult { name: string; tolerance: number; ratio: number; pass: boolean; pages: PageResult[]; error?: string; }
export async function runScenario(s: Scenario): Promise<ScenarioResult> {
  // try: setup() → exportPdf(doc) → render expectedBytes + result.bytes → per-page diffImageData
  //      → ratio = max page ratio → pass = ratio <= tolerance ; catch → red card with error text
}
```

**Step 5 — Round-trip scenario → `src/harness/roundTrip.ts` (+ `scenarios.ts` registry)**
```ts
export const roundTripScenario: Scenario = {
  name: 'Round-trip (zero edits)',
  tolerance: 0.001,
  async setup() {
    const res = await fetch(`${import.meta.env.BASE_URL}samples/sample-basic.pdf`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const { originalBytes, pages } = await loadDocument(bytes);   // reuse Task 2 loader
    return { doc: { originalBytes, edits: [], pages }, expectedBytes: originalBytes.slice() };
  },
};
// scenarios.ts → export const SCENARIOS: Scenario[] = [roundTripScenario];  (Tasks 10/14 push more)
```

**Step 6 — Red/green UI → `src/harness/VerifyPage.tsx`**
- On mount: `installHiddenRenderShim()`, run every `SCENARIOS` entry, render one card each — name, numeric
  `ratio` vs `tolerance`, a green/red **PASS/FAIL** badge, and `expected | actual | diff` canvases
  side-by-side. A **Run all** button re-runs.
- Publish for headless/CI: `window.__HARNESS_RESULT__ = results.map(r => ({ name, ratio, pass }))`, typed
  via `declare global { interface Window { __HARNESS_RESULT__?: {name:string;ratio:number;pass:boolean}[] } }`.

**Step 7 — DEV-only route → `src/routes.tsx` + one-line `main.tsx` change**
```tsx
const VerifyPage = import.meta.env.DEV ? lazy(() => import('./harness/VerifyPage')) : null;
const isVerify = () =>
  location.pathname.replace(/\/+$/, '') === '/verify' || location.hash.replace(/^#\/?/, '') === 'verify';
export function Root() {
  if (import.meta.env.DEV && VerifyPage && isVerify())
    return <Suspense fallback={<div className="p-6 text-neutral-500">Loading harness…</div>}><VerifyPage /></Suspense>;
  return <App />;
}
```
`main.tsx` renders `<Root/>` instead of `<App/>`. The `import.meta.env.DEV` guard + `lazy(() => import())`
makes Vite drop the entire harness chunk (and pixelmatch) from the production build.

**Step 8 — Verify**
- `npm run test` — 23 existing green (+ optional pixelDiff test). `npm run typecheck` / `npm run lint` — clean.
- **`npm run build`, then grep `dist/` for `pixelmatch` / `__HARNESS_RESULT__` / `VerifyPage`** → must be
  **absent** (proves the harness is tree-shaken from prod).
- **Runtime (the visible check):** `preview_start` → navigate to `http://localhost:5173/verify` → read
  `window.__HARNESS_RESULT__` → round-trip is **pass:true, ratio < 0.001**; screenshot the green card if the
  pane is shown. (The rAF shim makes this complete even though the pane is hidden.)

**Key decisions & edge cases**
- Both sides render through the **same pdf.js at the same scale + dpr=1**, so anti-aliasing is identical →
  a true zero-edit export diffs to ~0. pdf-lib re-serialization changes bytes but not rendered pixels
  (content streams copied verbatim) → we assert **visual, not byte, identity**.
- Reuses `loadDocument` (Task 2) and `exportPdf` (Task 4) unchanged — the harness calls the *real* path.
- Missing sample PDF → a red error card, never a crash.

**Commit strategy:** Phase-0 foundation; folds into the Task 7 acceptance commit (`Phase 0 ✓`).

### Task 7 — Phase-0 acceptance + commit  ✅
**Goal:** prove the round-trip is lossless.
**Deliverables:** round-trip ratio < 0.001; structural check (page count/size/rotation unchanged);
export re-opens in pdf.js clean.
**Depends on:** Task 6.
**Done when:** harness green → commit `Phase 0 ✓`.

#### Workflow

**What this task is (and isn't).** Not new features — the **acceptance gate + the first commit**. Confirm
Phase 0's three acceptance criteria are green, then make the `Phase 0 ✓` commit. Most of the proof already
exists (the Task 6 `/verify` harness + the Task 4 export test); Task 7 formalizes it, optionally hardens it
into a repeatable node test, and commits. It is the discipline gate: **no Phase 1 work starts until this
commit exists.**

**Step 1 — Confirm the three acceptance criteria (all already green):**
- **(a) Visual identity** — `/verify` round-trip ratio **< 0.001** (currently **0**), read from
  `window.__HARNESS_RESULT__`.
- **(b) Structural** — pdf-lib reopen → equal page count + per-page size + rotation (already asserted in
  `src/lib/export/exportPdf.test.ts`).
- **(c) Validity** — exported bytes re-open in pdf.js without error (the harness re-renders them to produce
  "actual").

**Step 2 — (Recommended) harden into a repeatable node test → `src/lib/export/acceptance.test.ts`**
Read the **real** `public/samples/sample-basic.pdf` from disk (Node `fs` — node has no `fetch`/DOM), run
`exportPdf` with zero edits, and assert on the *actual document*: output starts with `%PDF-`, reopens in
pdf-lib, page count unchanged, and each page's size + rotation unchanged. This moves the structural/validity
half of the acceptance into `npm run test` on the real file; the **visual** half stays in the browser
harness (pixel rendering needs a browser).

**Step 3 — Full green sweep (nothing red before committing):**
- `npm run test` (25+), `npm run typecheck`, `npm run lint`, `npm run build`.
- **Prod bundle grep** — `dist/` contains no `pixelmatch` / harness symbols.
- **`/verify`** — round-trip **PASS**, ratio < 0.001.

**Step 4 — Commit `Phase 0 ✓`:**
- `git add -A` (respects `.gitignore` — `node_modules` / `dist` excluded).
- `git commit -m "Phase 0 ✓"` on `main` — per the project's phase-commit discipline (Phase 6 auto-deploys
  from `main`). This is the repo's **first commit** (git was init'd but nothing committed through Tasks 1–6).
  No remote / no push yet — the remote is set up in Phase 6. Message ends with the standard `Co-Authored-By`
  trailer.

**Step 5 — Tick the docs:**
- `PROJECT_PROGRESS.md` → Phase 0 **Acceptance** section: all boxes + `Phase 0 ✓` checked; header set to
  "Phase 0 complete".
- `TASKS.md` → Task 7 marked ✅.

**Key decisions & notes**
- Acceptance = **visual + structural identity, NOT byte identity.** pdf-lib re-serializes the file (bytes
  differ) but copies content streams verbatim → identical render. Byte-equality is impossible and is never
  asserted.
- Commit lands on **`main`** (the project commits `Phase N ✓` to main). No push until Phase 6.
- **Gate:** Phase 1 (Tasks 8–9, first editing UI) must not start until this commit exists — never build
  features on an uncommitted / red foundation.

**Done when:** all checks green → `Phase 0 ✓` committed → Phase 0 closed, Phase 1 unblocked.

---

## Text editing

### Task 8 — Text run extraction & hit-testing  ✅
**Goal:** locate tappable text runs and their PDF-point rects.
**Deliverables:** `lib/pdf/textContent.ts` (`getTextContent()` → runs, font size from transform,
bold/italic from font name), positioned via `coordinates.ts`.
**Depends on:** Task 3, Task 7.
**Done when:** `extractTextRuns(page, i)` returns runs with correct text + PDF-point `rect` + `style`
(unit-tested on a synthetic PDF), and `hitTestRun` resolves a tap to the right run.

#### Workflow

**What this task is (and isn't).** Pure **read-side plumbing** — no visible UI, no export change. It
teaches the app *which* text sits *where*: for a page, produce each tappable **text run** with its
**PDF-point rect** + inferred **style**, plus a hit-test helper. **Task 9 consumes this** to draw the
tap-to-edit overlays. Reuses `coordinates.ts` (Task 3) and the page `viewport`; touches **no export path**.

**Step 1 — Types + font classifier → `src/lib/pdf/textContent.ts`**
```ts
export interface TextRun {
  pageIndex: number;
  text: string;
  rect: PdfRect;      // PDF points (bottom-left, unrotated) — same space as edits
  style: TextStyle;   // fontName, fontSizePt, bold, italic, color
}

// Pure, table-testable. Embedded PDF font names encode weight/style in the name.
export function classifyFontStyle(fontName: string): { bold: boolean; italic: boolean } {
  return {
    bold: /bold|black|heavy|semibold|[6-9]00/i.test(fontName),
    italic: /italic|oblique/i.test(fontName),
  };
}
```

**Step 2 — Extract runs from a page → `extractTextRuns(page, pageIndex)`**
```ts
const content = await page.getTextContent();
const base = page.getViewport({ scale: 1, rotation: 0 });   // our coordinate baseline
for (const item of content.items) {                          // TextItem: str, transform, width, height, fontName
  if (!('str' in item) || item.str.trim() === '' || item.width === 0) continue;   // skip empty/EOL/zero-width
  const m = pdfjs.Util.transform(base.transform, item.transform);                 // local → device (scale 1)
  const apply = (lx, ly) => ({ x: m[0]*lx + m[2]*ly + m[4], y: m[1]*lx + m[3]*ly + m[5] });
  const corners = [[0,0],[item.width,0],[0,item.height],[item.width,item.height]]
    .map(([lx,ly]) => viewportToPdf(base, apply(lx, ly)));                          // device → PDF points (reuses Task 3)
  const rect = boundingBox(corners);                                               // min/max → rotation-robust PdfRect
  const family = content.styles[item.fontName]?.fontFamily ?? item.fontName;
  runs.push({ pageIndex, text: item.str, rect, style: {
    fontName: family,
    fontSizePt: Math.hypot(m[2], m[3]),                                            // vertical scale = font size in pt
    ...classifyFontStyle(family),
    color: { r: 0, g: 0, b: 0 },                                                   // see limitation below
  }});
}
```
A "run" = one `getTextContent` item (a word/line chunk, as the PDF provides). Rect + font-size come out in
**PDF points** by pushing the item's four corners through `viewportToPdf` — no new coordinate math.

**Step 3 — Hit-test helper**
```ts
// Resolve a tap (already converted to a PDF point via coordinates.ts) to the topmost/smallest run under it.
export function hitTestRun(runs: TextRun[], point: PdfPt): TextRun | undefined { /* point-in-rect, min area on ties */ }
```

**Step 4 — Tests → `src/lib/pdf/textContent.test.ts`** (Vitest, node + pdfjs legacy)
1. `classifyFontStyle` table: `Helvetica`→{}, `Arial-BoldMT`→bold, `Times-Italic`→italic, `Helvetica-BoldOblique`→both.
2. **Integration:** build a pdf-lib PDF with a known string (e.g. `Hello` at x≈100, y≈700, size 24) → load via
   pdfjs → `extractTextRuns` → assert one run: `text==='Hello'`, `fontSizePt≈24`, `rect` near the expected
   PDF coords, not bold/italic.
3. `hitTestRun`: a point inside the run's rect returns it; outside returns `undefined`.

**Step 5 — Verify**
- `npm run test` (26 → ~29), `npm run typecheck`, `npm run lint` — clean. No dev-server/visual check (plumbing).

**Key decisions & edge cases**
- **Reuses `coordinates.ts`** (`viewportToPdf`) — rects land in PDF points; rotation handled by the min/max box.
- **Color is defaulted to black.** `getTextContent()` does not reliably expose glyph color; precise color can
  be sampled from the locked raster in a later refinement. Documented limitation.
- **Run granularity** = whatever `getTextContent` emits (word/line). Merging adjacent runs is a future nicety.
- Extraction is **lazy per page** (Task 9 extracts the visible/tapped page on demand, not all pages eagerly).
- **Touches no export path** → commits on the *feature* side, separate from any export-path commit (Task 10).
  No `Phase N ✓` yet; accumulates toward the Phase 1 acceptance.

### Task 9 — Text edit overlay + controls  ✅
**Goal:** tap a run → contenteditable exactly over the glyphs, with size, weight/style, and width controls.
**Deliverables:** `components/TextEditOverlay.tsx` (A−/A+ size, **B / I toggles**, width-drag); commit emits a
`CoverEdit{sampleBackground}` + a `TextEdit`; `components/HoldToPeek.tsx`.
**Depends on:** Task 8.
**Note (bold/italic):** The overlay's **B** and **I** buttons flip `style.bold` / `style.italic` on the
emitted `TextEdit`. This is UI-only — the model (`TextStyle`) and both export paths already carry and
render bold/italic (English → Helvetica/Times/Courier bold+oblique standard fonts in Task 10; Indic →
Noto Bold + synthetic oblique in Task 13). A tapped run's original weight/style is detected and shown as
the initial toggle state, so edits *preserve* it by default and can *change* it. (Text color is likewise
already in `TextStyle` and can be added the same way if wanted later.)
**Done when:** tap a run → edit in place (text, A−/A+, B/I, width-drag); committing puts the correct
`CoverEdit` + `TextEdit` in the edits store (unit-tested) and updates the on-screen overlay live;
hold-to-peek reveals the original. *(Exported-PDF proof of text is Phase 1's acceptance after Task 10.)*

#### Workflow

**What this task is (and isn't).** The **first interactive feature** — tap a text run → edit it in place.
It consumes Task 8's runs, emits `CoverEdit` + `TextEdit` into an edits store, and shows the edit **live on
screen**. It does **not** implement text *export* — `drawText` stays a guarded stub until **Task 10** — so
Task 9 is verified on-screen + by unit-testing the pure edit-emission; the exported-PDF proof is Phase 1's
acceptance (after Task 10). Touches **viewer / UI / state only — no export-path files.**

**Step 1 — State stores → `src/state/{documentStore,editsStore}.tsx`** (lightweight Context + `useReducer`)
- `documentStore` — holds the `LoadedDocument` (`doc`, `originalBytes`, `pages`); `App` sets it on open and
  reads from it (small refactor from today's local `doc` state). `originalBytes` + `pages` are what export
  and the overlay coordinates need.
- `editsStore` — `Edit[]` with `addEdits` / `updateEdit` / `removeEdit` + a `useEdits()` hook.

**Step 2 — Font-family classifier → add `classifyFontFamily` to `src/lib/pdf/textContent.ts`**
`classifyFontFamily(name): 'serif' | 'sans' | 'mono'` (times/georgia/serif → serif; courier/mono/consolas →
mono; else sans). Read-side pure helper; **Task 9 maps it to a CSS family**, **Task 10 maps the same classes
to pdf-lib standard fonts** — one source of truth, no duplication.

**Step 3 — Pure edit-emission → `src/lib/edit/buildTextEdits.ts`** (node-testable, no DOM)
```ts
export function buildTextEdits(
  run: TextRun,
  next: { text: string; style: TextStyle; width: number },
  z: number,
): { cover: CoverEdit; text: TextEdit } {
  const cover: CoverEdit = { id: id(), kind: 'cover', pageIndex: run.pageIndex, rect: run.rect, z, sampleBackground: true };
  const text: TextEdit   = { id: id(), kind: 'text', pageIndex: run.pageIndex,
    rect: { ...run.rect, w: next.width }, text: next.text, style: next.style, z: z + 1 };
  return { cover, text };
}
```
Cover hides the original glyphs; text draws the new content above it. (Cover color falls back to white until
Task 10 wires raster mode-sampling — seamless on white pages like the sample.)

**Step 4 — Interactive overlay layer → `src/components/OverlayLayer.tsx`** (per page, over the locked canvas)
- On mount: `extractTextRuns(page, pageIndex)` (Task 8).
- Render, positioned via `pdfRectToScreenRect(rect, viewport, dpr)`: a transparent **tap target** per run
  (opens the editor), plus this page's committed `TextEdit` overlays (live edited text on an opaque patch).
- Tapping a run that already has an edit **re-opens that edit** (keyed by run) instead of stacking a new one.

**Step 5 — The editor → `src/components/TextEditOverlay.tsx`**
- A `contenteditable` at the run's screen rect, seeded with the run text; CSS `fontSize = fontSizePt * zoom`,
  family from `classifyFontFamily`, `fontWeight`/`fontStyle` from bold/italic, `color`, opaque background so
  the original is hidden while editing.
- Floating controls: **A− / A+** (fontSizePt ±1), **B**, **I** (toggle), a **width-drag** handle, **Done** /
  **Cancel**.
- On **Done**/blur → `buildTextEdits(run, { text, style, width }, nextZ)` → `editsStore.addEdits([cover, text])`
  (or `updateEdit` when re-editing). **Cancel** discards.

**Step 6 — Hold-to-peek → `src/components/HoldToPeek.tsx`**
A button that, while pressed (`pointerdown`→`pointerup`/leave), sets a `peek` flag hiding all overlays to
reveal the untouched original page; release restores them.

**Step 7 — Wire into the viewer**
`PageCanvas` renders `<OverlayLayer>` absolutely over its canvas, passing `page`, `pageIndex`, `viewport`,
`dpr`, `zoom`, and the page's `PageGeometry`. `Toolbar` gains an **Edit text** toggle + the `HoldToPeek`
button; `App` reads document/edits from the stores. (The Export/download button stays **Task 10**, since text
export isn't real until then.)

**Step 8 — Verify**
- **Unit (node):** `buildTextEdits` — cover uses the original rect + `sampleBackground`; text carries the new
  text/style + width-adjusted rect + z above the cover; A±/B/I changes are reflected in `TextEdit.style`.
- `npm run test` / `typecheck` / `lint` — green.
- **Browser (the visible check):** load the itinerary → tap a line → edit text, A±, B/I, width-drag → the line
  updates live; hold-to-peek shows the original. (I can drive the in-app pane's overlay DOM; you confirm
  visually in Chrome.)

**Key decisions & edge cases**
- **No text export yet** — `drawText` is a stub till Task 10; Task 9 proves the *authoring* half. The `cover`
  exports fine (real handler); text-in-the-exported-PDF is Phase 1's post-Task-10 acceptance.
- **Cover color** defaults to white now (mode-sampling = Task 10).
- **Coordinates reuse** `pdfRectToScreenRect` — overlays stay pinned under zoom/dpr; no new transform code.
- **Re-edit, don't stack** — tapping a run with an existing edit updates it.
- **Commit:** feature-side (viewer / UI / state), kept **separate from the Task 10 export-path commit**; both
  land under `Phase 1 ✓` after the acceptance.

### Task 10 — English export path (font map + cover)  ✅
**Goal:** render English edits with standard fonts and hide the original.
**Deliverables:** `englishFont.ts` mapping table (serif/sans/mono × bold/italic; unknown → warn),
`handlers/text.ts` (English drawText; Indic → Path A stub), `handlers/cover.ts` (mode-color sampling
from the locked raster), export `warnings[]` surfaced as a toast; harness English-edit scenario.
**Depends on:** Task 9. *(Export-path work — separate commit from Task 9.)*
**Done when:** edit one line of a real PDF; layout holds when opened in Adobe Reader on Android.

#### Workflow

**What this task is (and isn't).** The **export-path** half of Phase 1 — it makes English text edits
actually render into the downloaded PDF. Fills the `drawText` + `colorSample` stubs, wires the **Export**
button + substitution warnings, and adds a harness scenario. Indic text still routes to the Path A stub
(Task 13). **This is an export-path commit — separate from Task 9's feature commit** (the discipline).

**Step 1 — Standard-font mapping → `src/lib/export/englishFont.ts`** (fill the Task-4 stub)
- Reuse `classifyFontFamily` (Task 9) → serif/sans/mono; combine with `bold`/`italic` → one of the 14
  standard fonts (Times / Helvetica / Courier × Regular/Bold/Italic/BoldItalic).
- Embed via `pdf.embedStandardFont`, **cached per document** — a module-level
  `WeakMap<PDFDocument, Map<StandardFonts, PDFFont>>` keyed on `ctx.pdf` (no re-embedding, no seam change).
- **Warn on uncertain substitution:** an unrecognized name defaults to Helvetica and pushes
  `ctx.warnings.push("Font 'X' substituted with Helvetica; widths/kerning may differ.")`.

**Step 2 — Real text handler → `src/lib/export/handlers/text.ts`** (replace the guarded stub)
```ts
export const drawText: EditHandler<TextEdit> = async (edit, ctx) => {
  if (isIndicRun(edit.text)) return drawIndicTextPatch(edit, ctx);   // Path A — stub until Task 13
  const font = await resolveEnglishFont(edit.style, ctx);
  ctx.page.drawText(edit.text, {
    x: edit.rect.x, y: edit.rect.y,                    // rect.y ≈ baseline (Task 8 convention)
    size: edit.style.fontSizePt, font,
    color: rgb(edit.style.color.r, edit.style.color.g, edit.style.color.b),
  });
};
```
**Baseline:** Task 8's `rect.y` is the text baseline, so `y = rect.y` lands the replacement on the original
line. (If some PDF's `item.height` includes descent, add a small baseline correction — verify in the harness.)

**Step 3 — Cover color from the locked raster → `src/lib/export/colorSample.ts`** (fill the stub) + app callback
- `sampleDominantColor(pixels): Rgb` — **mode** over 5-bit-per-channel quantized buckets (anti-alias-robust,
  not a mean).
- The **app provides `doc.sampleBackground(pageIndex, rect)`**: find that page's rendered canvas + viewport,
  convert the PDF rect → canvas px (`pdfToViewport`), `getImageData`, `sampleDominantColor`.
  `handlers/cover.ts` already calls `ctx.sampleBackground` → **no change to cover.ts**; it now returns the
  true background instead of falling back to white.

**Step 4 — Export button + download + warnings → `Toolbar` / `App`**
- `Toolbar` gains **Export**. `App`:
  `const { bytes, warnings } = await exportPdf({ originalBytes, edits, pages, sampleBackground })` → download
  the Blob via a temporary `<a download>` (user-initiated) → if `warnings.length`, show a toast listing the
  font substitutions.

**Step 5 — Page-canvas registry for sampling → small wiring**
`PageCanvas` registers its `canvas` + `viewport` per `pageIndex` (in `documentStore` / a ref map) so
`sampleBackground` can read pixels from the **locked raster**. (Offscreen re-render is the alternative; reusing
the displayed canvas is cheaper.)

**Step 6 — Harness English-edit scenario → `src/harness/scenarios.ts`**
Scripted English text edit (cover + text) on the sample → export → re-render. **PASS when:** the export is
valid + re-renders, and the **unedited pages stay pixel-identical to the original** (proves no collateral
layout shift). (Edit-region pixel-verify against a reference render is more meaningful for Indic — Task 14.)

**Step 7 — Tests → `englishFont.test.ts`, `colorSample.test.ts`, an export-text test**
- `resolveEnglishFont`: every family × bold × italic → the right StandardFont; unknown name → Helvetica +
  a warning.
- `sampleDominantColor`: dominant color wins over anti-aliased noise.
- **Export round-trip:** apply an English `TextEdit`, `exportPdf`, reload via pdfjs, `getTextContent` → the
  **new text string is present** (proves `drawText` wrote it) and page structure is unchanged.

**Step 8 — Verify + Phase 1 acceptance**
- `npm run test` / `typecheck` / `lint` / `build` — green; `/verify` English-edit scenario green.
- **Acceptance (the payoff):** load the itinerary → tap a line → edit → **Export** → open the downloaded PDF
  in Adobe Reader on Android → the edit is in place and **layout holds**.
- **Commit:** export-path commit, **separate from Task 9's feature commit**. The `Phase 1 ✓` marker lands at
  the *end* of Phase 1 (after the Task 11 popover), not on this commit.

**Key decisions & edge cases**
- **Substituted standard fonts, not the original embedded font** — widths/kerning differ; always surfaced via
  `warnings`. (Faithful original-font re-embedding is out of scope by design.)
- **No auto-fit / wrapping** — text draws at its size on one baseline; an over-long replacement can overflow
  the width. Wrapping is a future nicety; width-drag governs the cover/overlay extent.
- **Cover sampling** reads the locked raster (mode color) via the app callback — `cover.ts` stays as-is.
- **Indic still stubbed** — Indic text edits throw until Task 13; English is fully live here.

### Task 10a — Text-edit fixes: move · run-switch leak · font picker  ✅
**Goal:** fix three issues found in the Task 9/10 build — (1) you can't move the text box, (2) editing one
run then tapping another shows the first run's text on it, (3) no way to pick a closer font.
**Deliverables:** move handle + offset plumbing; per-run remount of the editor; a font-family picker.
**Depends on:** Task 9, Task 10. *(All feature-side — no export-path file changes; lands with the Phase 1
feature commit.)*
**Done when:** the box can be dragged to a new position (and re-edited there); switching runs never carries
over the previous run's text; a font picker changes the family for both the live preview and the selectable
export; `npm run test` / `typecheck` / `lint` green.
**Decision locked:** font handling = **Option 2** — exported text stays **real/selectable**; the picker
chooses the closest standard family (exact brand-font match via image patch was rejected to keep text
copyable/searchable).

#### Workflow

All three are feature-side (viewer / UI / `buildTextEdits`) — **no `englishFont.ts` / `handlers` / export
changes**. `textStyleCss` + `englishFont` already respect recognized family names, so the picker needs no
export-path edit.

**Fix 1 — Run-switch leak (issue #2, the important one) → `src/components/OverlayLayer.tsx`**
*Root cause:* `<TextEditOverlay>` is rendered **without a React `key`**, so switching `activeRun` A→B (tapping
another run without pressing Done) reuses the same instance — its `useState`-seeded `text`/`style`/`width`
and the `contentEditable` DOM keep run A's "Mrs. Priya", which then commits onto run B.
*Fix:* give it a stable per-run key so it **remounts fresh** each switch:
```tsx
<TextEditOverlay
  key={`${activeRun.pageIndex}:${activeRun.rect.x}:${activeRun.rect.y}`}
  ...
/>
```
Switching runs discards an uncommitted edit (explicit **Done** to save) — acceptable and predictable.

**Fix 2 — Move the text box (issue #1) → `buildTextEdits.ts`, `TextEditOverlay.tsx`, `OverlayLayer.tsx`**
- **`src/lib/edit/buildTextEdits.ts`** — extend `NextTextEdit` with a PDF-point move offset and accept a
  `base` rect (so re-edits move relative to the current position, not the original):
  ```ts
  export interface NextTextEdit { text: string; style: TextStyle; width: number; dx: number; dy: number; }
  export function buildTextEdits(run, next, z, base: PdfRect = run.rect) {
    // cover ALWAYS at run.rect (keeps hiding the original glyphs, even after a move)
    // text.rect = { x: base.x + next.dx, y: base.y + next.dy, w: next.width, h: base.h }
  }
  ```
- **`src/components/TextEditOverlay.tsx`** — add a **move grip** (a draggable handle, e.g. a corner grip)
  mirroring the existing width-drag: track a screen-px `moveOffset {x,y}`, apply it to the box `left/top`
  for live feedback, and on commit report `dx = moveOffset.x / zoom`, `dy = -moveOffset.y / zoom` (y flips:
  screen y-down → PDF y-up). Same rotation-0 assumption as the existing width-drag (note as a limitation).
- **`src/components/OverlayLayer.tsx`** — two changes:
  - Make `findExisting` match on the **cover** (which never moves) instead of the text: find the `CoverEdit`
    whose rect ≈ `run.rect`, then its paired `TextEdit` (`z === cover.z + 1`). This keeps re-edit working
    after a move (the old text-rect match breaks once the text moves).
  - In `onDone`, pass the base: `buildTextEdits(activeRun, next, nextZ, existing?.text.rect ?? activeRun.rect)`.
  - *(Re-edit UX: the run's tap target stays at the original spot; tapping it re-opens the editor at the
    moved location. Making the moved overlay itself clickable is a later nicety.)*

**Fix 3 — Font picker (issue #3, Option 2) → `src/components/TextEditOverlay.tsx`**
Add a family `<select>` (Sans / Serif / Mono) next to A−/A+/B/I. It sets `style.fontName` to a **recognized
keyword** so existing classification drives both preview and export — no type or export-path change:
```ts
const FAMILY_KEYWORD = { sans: 'Arial', serif: 'Times New Roman', mono: 'Courier New' };
// current value = classifyFontFamily(style.fontName); onChange → setStyle(v => ({ ...v, fontName: FAMILY_KEYWORD[value] }))
```
`classifyFontFamily` (in `textContent.ts`) maps these → serif/sans/mono for `textStyleCss` (CSS preview) and
`englishFont` (standard font on export). Bonus: picking a family suppresses the substitution warning
(`KNOWN_FONT` already matches arial/times/courier). Leaving it untouched keeps the detected original.

**Tests & verify**
- Update `src/lib/edit/buildTextEdits.test.ts` for the new `NextTextEdit` (`dx`/`dy`) + add cases: a move
  offset shifts the text rect but not the cover; a `base` re-edit moves relative to the base.
- `npm run test` / `typecheck` / `lint` — green (existing 59 stay green).
- **Browser:** tap a run → move it, resize width, change family, edit text → Done; tap a *different* run →
  it shows *its own* text (no leak); re-tap the first → re-opens with the moved position; Export → the
  edited text is real/selectable and in the chosen family.

**Commit:** feature-side only — folds into the Phase 1 feature commit (separate from the Task 10 export-path
commit).

### Task 10B — Text-edit fixes r2: on-screen cover · reversed typing · line/paragraph editing  ✅
**Goal:** fix three issues found after Task 10a — (1) moving a text box leaves the original text visible
underneath; (2) typing goes in backwards ("days" → "syad"); (3) you can only edit one word/run, not a
line or paragraph.
**Deliverables:** on-screen cover patches; an uncontrolled `contentEditable`; line-merging + block
(drag) selection with multi-line editing/export.
**Depends on:** Task 10a.
**Done when:** moving a box hides the original in the live view; typing reads forward; tapping a short
field edits just it, tapping a paragraph opens the whole block in a multi-line box, and either exports
correctly; `npm run test` / `typecheck` / `lint` green.
**Note (why tests passed anyway):** all three are runtime/DOM behaviours the current node tests don't
exercise — see "Testing gap" below. Baseline is 61 green.

#### Workflow

**Fix 1 — Moving leaves the original behind (image 1) → `src/components/OverlayLayer.tsx`**
*Root cause:* the live overlay renders the `TextEdit` (a `bg-white` box) at `edit.rect`, but **nothing
renders the cover on screen**. While the text sits on top of the original it incidentally hides it — but
once you **move** it (or while dragging), `edit.rect` ≠ `run.rect`, so the original glyphs on the locked
canvas are exposed. (Export is already correct — the `CoverEdit` hides them there.)
*Fix:* render an **opaque cover patch on screen** for every `CoverEdit` at its `rect` (= the original
`run.rect`), and also under the **active** editor at `activeRun.rect`, so the original is always hidden in
the preview regardless of where the replacement sits. Fill it with the **sampled background colour** (reuse
the App's `sampleBackground` via `documentStore.getPageCanvas` + `sampleDominantColor`), not hard-coded
white — otherwise edits over coloured areas (e.g. the blue "Guest Information" bar) look wrong on screen
even though the export is right. *(This also fixes the related white-box-vs-sampled-colour mismatch.)*

**Fix 2 — Typing is reversed (image 2, "days" → "syad") → `src/components/TextEditOverlay.tsx`**
*Root cause:* the editor is a **controlled `contentEditable`** — it renders `{text}` as a child *and*
`setText` on every `onInput`. React re-renders and overwrites the text node against its own previous vdom,
which **collapses the caret to the start**, so each new character is inserted at the front → the string
reverses. (Classic React contentEditable bug; `suppressContentEditableWarning` hides the warning, not the
bug.)
*Fix:* make it **uncontrolled**:
```tsx
const ref = useRef<HTMLDivElement>(null);
useEffect(() => {
  const el = ref.current; if (!el) return;
  el.textContent = existing?.text ?? run.text;   // set ONCE
  el.focus(); /* place caret at end */
}, []);
// JSX: <div ref={ref} contentEditable suppressContentEditableWarning ... />   // NO {text} child, NO onInput→setText
const commit = () => onDone({ text: ref.current?.textContent ?? '', style, width, dx, dy });
```
Drop the `text` state (the value is read from the DOM at commit). This makes typing read forward.

**Fix 3 — Edit the natural block (word/field OR paragraph), never word-by-word (image 3) → `textContent.ts`, `OverlayLayer.tsx`, `TextEditOverlay.tsx`**
*Requirement (clarified by the user):* the tap unit must **match the content**. A standalone short field
like "Mr. Pratik" is one word — you tap and change it. But a 5–6 line description must open as **ONE
editable box containing the whole paragraph** (a writable multi-line box), not word-by-word. So the rule
is: **tapping any text selects its whole block, and you edit it in a text box.**
*Root cause:* runs are raw `getTextContent` items (single words/fragments like "anoram" from
"panoramic"), so a tap edits one fragment.
*Fix — auto-group into blocks + a multi-line editor:*
- **Group runs into blocks** in `textContent.ts` (`groupRunsIntoBlocks(runs): TextBlock[]`): first merge
  items sharing a baseline into a **line** (sort by x, insert spaces on x-gaps, union the rects, pick a
  representative style); then merge vertically-adjacent lines that share a column and a consistent
  line-height into a **paragraph block**. A standalone value ("Mr. Pratik") becomes a 1-line block; a
  description becomes a multi-line block. Tune with two thresholds (baseline tolerance, inter-line gap).
- **Tap any run → select its whole block** → open a **multi-line edit box** (a `<textarea>`-style editor,
  newlines allowed) seeded with the block's text. One-line blocks behave like today's simple inline edit;
  multi-line blocks hand you the whole paragraph to rewrite. (No drag-select needed — tap gives the block.)
- **Export:** emit **one `CoverEdit`** over the block region + the new text as **wrapped lines** (wrap to
  the block width via canvas `measureText`), **one `TextEdit` per line** at
  `baseline = blockTopBaseline − i·lineHeight`. Reuses the single-line text handler — **no export-path
  change.**
*Limitation (v1 — flagged for a decision):* the app's core promise is "layout never shifts," so we can't
push the rest of the page down. Rewording a paragraph to a **similar length** is seamless; if the new text
needs **more lines** than the original block, the extra lines grow downward and can overlap whatever is
below. True reflow (pushing content down) is explicitly out of scope — this is the one case to keep an eye
on.

**Other problems found (this pass)**
- **On-screen colour fidelity** — overlays/covers use hard-coded `bg-white`; export uses the sampled colour.
  Folded into Fix 1 (sample on screen too).
- **Testing gap** — none of these were caught because the suite is node-only and doesn't render the editor.
  Add either (a) a jsdom + `@testing-library/react` setup for a couple of `TextEditOverlay` interaction
  tests (typing stays forward; move offset → dx/dy), or at minimum (b) pure-logic unit tests for
  `mergeRunsIntoLines` and the block line-wrapping. *(Recommend at least the pure-logic tests now.)*

**Verify**
- `npm run test` / `typecheck` / `lint` — green (add the tests above).
- **Browser:** move a box → original disappears in the live view; type "days" → shows "days"; tap a field
  ("Mr. Pratik") → edit just it; tap a paragraph → the whole block opens in a multi-line box → Export → the
  paragraph is replaced and selectable.

**Commit:** feature-side (viewer / UI / `textContent` merge) — folds into the Phase 1 feature commit. 3b emits
per-line edits so the export path (`handlers/text.ts`) stays untouched.

#### Round 3 — follow-up fixes (spacing · short-field edit · full cover · editor robustness)  ✅

**What surfaced testing the 10B build (4 issues):** (1) pressing Enter drops **two lines** of gap, not one;
(2) editing a small numeric field spawns an extra line that **can't be deleted**; (3) **moving a block
leaves part of the original text behind**, which then collides with the text below; (4) space/Enter leave a
big gap and clicking a word to edit "feels weird." *(Tests are 67 green — again these are DOM behaviours the
node suite doesn't exercise.)*

**Root-cause headline:** the editor is **still a `contentEditable`** (`TextEditOverlay.tsx` ~L160), not a
`<textarea>`. Codex made it "uncontrolled" (sets `textContent` once, reads `innerText` on commit) but kept
`contentEditable`, whose Enter inserts block elements → `innerText` yields extra `\n`s (issue 1/4), stray
empty lines can't be backspaced (issue 2), and caret/click are flaky (issue 4). This is exactly the
`<textarea>` swap recommended before — do it now.

**Fix E — Replace the `contentEditable` with a real `<textarea>` (fixes 1-source, 2, 4).**
A `<textarea>` gives a single `\n` per Enter, normal backspace/deletion, and clean clicking, and is natively
multi-line. Keep it uncontrolled-simple (`defaultValue` = block/existing text; read `.value` on commit →
`wrapTextToLines`). Style it via CSS (font family/size/weight/italic/color, and `lineHeight` matched to the
export spacing). **Keep all the controls** (move grip, width-drag, A−/A+, B/I, font picker) around it.

**Fix F — Natural line spacing, on screen AND on export (fixes 1, 4).**
- The exported per-line step in `buildTextBlockEdits` (`lineHeight`) must be the block's **natural
  single-line height** (≈ `block.lineHeightPt`, ~1.15-1.25× font) — never doubled.
- Collapse blank lines: `wrapTextToLines` currently emits `''` for a blank paragraph → an extra empty line.
  With the textarea, one Enter must yield exactly one line down (drop/skip empty wrapped lines, or don't add
  a line-height for them).
- The `<textarea>`'s on-screen `lineHeight` must equal the export step so it's WYSIWYG.

**Fix G — Fully & opaquely cover the original block (fixes 3).**
*Root cause:* the editable box is now `bg-transparent` (`TextEditOverlay.tsx` ~L169), so only the separate
cover hides the original — and the cover rect can be **tighter than the visible glyphs** (ascenders/
descenders), leaving remnants when the block is moved. *Fix:* ensure the on-screen cover spans the **full
block extent with a little padding** (pad by the font's ascent/descent), rendered **both while dragging and
after commit**; verify `block.rect` actually matches the visible text. Nothing transparent should reveal the
original at its old spot.

**Fix H — Grouping tuning for short/standalone items (fixes 2, partial).**
The "1 / 2" case suggests unrelated short items (separate table numbers/cells) are being **merged into one
multi-line block**, which then edits oddly. Tune `groupRunsIntoBlocks` thresholds so items in **different
columns** or separated by a **large vertical gap** stay **separate blocks** (don't merge a lone number with
the row below it). Re-check with the numbers case in image 2.

**Tests & verify (Round 3)**
- Update `src/lib/edit/textLayout.test.ts` (blank-line collapse; one Enter = one line) and the block
  emission tests (natural `lineHeight`, no doubling). Add a `groupRunsIntoBlocks` case for the short-number
  scenario.
- **Browser:** Enter → exactly one line down; edit a number → deletes cleanly; move a paragraph → the
  original is fully hidden (no leftovers, no collision at the source); clicking a word feels normal.

**Commit:** still feature-side (editor + `textLayout` + `buildTextEdits` emission + grouping) — folds into the
Phase 1 feature commit; **no export-path change** (line-height lives in the block emission, not `handlers`).

### Task 10C — Text edit FINAL design: paragraph box · wrap · shrink-to-fit · per-line covers  ✅
**Goal:** converge the text editor on one robust, layout-safe model after several patch rounds. This is the
**source of truth** for text-edit behaviour and **supersedes the "grow downward / overflow + overlap"
guidance in 10B Round 3 (Fix F/G)** — overflow is now handled by **shrink-to-fit**, not downward growth.
**Depends on:** Task 10B.
**Done when:** editing a field or a paragraph never overlaps neighbours, never leaves remnants, never
changes a whole box's colour, never splits short fields, and edited blocks can be re-opened; tests /
typecheck / lint green.

**Decisions locked (do not re-litigate):**
- **Edit unit = the whole paragraph/block** in ONE wrapping editor box (NOT line-by-line — sentences span
  lines, so line-wise would chop them).
- **Wrapping stays** (long text must wrap, not run off the box).
- **Overflow = auto-shrink-to-fit:** when wrapped text needs more room than the block's ORIGINAL area, reduce
  the font size so the whole block fits its **original footprint**. The block always occupies exactly its
  original box → never overlaps neighbours, never pushes the page down. (This is the chosen answer to
  "layout never shifts.")
- **Per-line, local-colour covers** (not one solid block colour).

#### Workflow

**1 — Shrink-to-fit layout → `src/lib/edit/textLayout.ts` (+ block emission in `buildTextEdits.ts`)**
Given the block's original width `W` and height `H` (both fixed) and the new text, find the **largest font
size ≤ the original** such that `wrapTextToLines(text, W, measureAt(size))` produces lines whose
`count × lineHeight(size) ≤ H`. Binary-search / step down the size (tiny floor ~4pt to avoid degenerate 0).
Emit the wrapped lines at that fitted size, top-aligned to the block's original top baseline, each line a
`TextEdit`. Result: the edited block always fits its original box. *(This replaces the "extra lines grow
downward" behaviour.)*

**2 — Per-line, local-colour covers → `OverlayLayer.tsx` + `buildTextEdits.ts` (fixes remnants #2 + whole-box
colour #3)**
Instead of one `CoverEdit` over the whole block filled with a single dominant colour, emit **one cover per
original line** (each line's tight bbox, padded by ascent/descent), and sample **each line's own local
background colour**. A line on the blue bar → blue cover; a line on white → white cover. On screen, render
these per-line covers (committed and while editing) so the original is fully hidden with correct colours.

**3 — Editor = comfortable typing, result = fitted → `TextEditOverlay.tsx`**
Keep the `<textarea>` (Round 3) for input; type at a comfortable size (scroll if long). Apply **shrink-to-fit
to the committed overlay + export**, so the *result* matches what lands in the PDF. Give the box a **sensible
minimum width** (≥ the block's natural width) so short fields like "N/A" never wrap/split (#4). Keep the
move grip, width-drag, A−/A+, B/I, and font picker.

**4 — Fix re-edit → `OverlayLayer.tsx` (fixes #1b)**
Tapping an already-edited block must re-open it. Make the association robust (match the block to its cover by
the padded origin, as now) AND make the **committed text overlay itself tappable** in edit mode (so tapping
the visible edited text — even if moved — re-opens it). Verify with a field edited once, then tapped again.

**5 — Grouping sanity → `textContent.ts` (carries over from 10B Fix H)**
Keep short/standalone items (separate table numbers/cells, different columns, large vertical gaps) as
**separate blocks** so they don't merge oddly.

**Maps to the reported issues:** #1a (long name) → shrink-to-fit keeps it in the box; #1b → step 4; #2 →
per-line covers padded; #3 → per-line local colours; #4 → min-width + shrink-to-fit (no odd wrap).

**Tests & verify**
- Unit: shrink-to-fit picks the largest fitting size and never exceeds `H`; wrapping respects `W`; grouping
  keeps short items separate. Update `textLayout.test.ts` / block-emission tests.
- **Browser:** edit "Mr. Pratik" to a long name → it shrinks to stay in the cell, no overlap; edit a 5-line
  paragraph longer → shrinks to fit, no collision; edit text on the blue header → only that text changes,
  colour preserved; "N/A" stays one line; re-tap any edited block → re-opens; Export → matches the preview.

**Commit:** feature-side (editor + `textLayout` + emission + covers + grouping) — folds into the Phase 1
feature commit; still **no export-path change** (fitting/wrapping live in the block emission, not `handlers`).

### Task 10D — Text edit: user-controlled resizable box (replaces auto-shrink)  ✅
**Goal:** fix three issues from testing 10C — (1) widening the box doesn't reduce wrapping; (2) A+/A− can't
change size ("size is fixed"); (3) spaces / blank lines are dropped. Root cause of 1 & 2: the **auto
shrink-to-fit (`fitTextToBlock`) overrides the user's manual width and font size.**
**This SUPERSEDES the auto-shrink-to-fit decision in Task 10C.** New model: the **user controls the box**;
the text lives inside it; if it doesn't fit, it **overlaps** (visible) until the user makes the box bigger.
**Depends on:** Task 10C.
**Done when:** widening the box reduces wrapping; A+/A− actually change the text size; spaces and blank lines
are preserved; making the box bigger removes overlap; re-edit still works; tests/typecheck/lint green.

**Decisions locked (from the user):**
- **Manual wins, no auto-shrink.** Font size (A+/A−) and box **width AND height** are set by the user and are
  authoritative. Remove `fitTextToBlock` from the commit/render path (the function may stay unused).
- **Text wraps to the box width** at the user's font size — so widening ⇒ fewer lines, A+ ⇒ bigger text.
- **Overflow = overlap, not shrink.** If the wrapped text is taller/wider than the box, it **spills and can
  overlap** neighbouring content. The user fixes it by **enlarging the box** ("increase the box → overlap
  ends; keep it the same → overlap happens"). Show a subtle **overlap warning** (e.g. amber outline) while
  content exceeds the box.
- **Keep** per-line local-colour covers (hide the original), re-edit, and move.

#### Workflow

**1 — Make the box user-resizable in BOTH dimensions → `TextEditOverlay.tsx`**
- Keep the width-drag; **add a height-drag handle** (bottom edge) and ideally a **corner handle** (bottom-
  right) for width+height together. Track `height` in state like `width`; the box uses the user's `height`
  (not a line-count-derived height).
- Font size stays fully manual (A+/A−). The `<textarea>` renders at `style.fontSizePt` and wraps to the box
  width; it scrolls if content exceeds the box (so typing stays usable).

**2 — Remove the shrink-to-fit override → `OverlayLayer.tsx` onDone (+ `buildTextEdits.ts`)**
- Stop calling `fitTextToBlock`. Wrap the text to the **box width** at the **user's font size**
  (`wrapTextToLines(next.text, boxWidth, measureAtUserSize)`), and emit those lines at the user's size.
- Emit line positions from the box top downward at the block's natural line-height for that size; lines that
  exceed the box height simply sit lower (they overlap what's below — accepted).
- `NextTextEdit` gains `height` (box height) alongside `width`, so emission/overlap can use it.

**3 — Covers = hide the original; box can differ → `buildTextEdits.ts` / `OverlayLayer.tsx`**
Keep the **per-line local-colour covers over the ORIGINAL block** (so the original is always hidden,
regardless of the new box size/position). The new text draws in the user's box on top. Growing/moving the box
does not change what's covered (the original), so no remnants and no wrong colours.

**4 — Preserve whitespace & blank lines → `textLayout.ts` (fixes #3)**
`wrapTextToLines` currently does `paragraph.trim().split(/\s+/)`, which **collapses multiple spaces and drops
blank lines**. Change it to: split on `\n` **keeping empty lines** (each blank line → one output line), and
wrap each line by words **without trimming** so typed spaces are preserved. Blank lines occupy one line-height
in the output.

**5 — Overlap warning → `OverlayLayer.tsx` / `TextEditOverlay.tsx`**
Compute whether the wrapped content (lines × line-height, and widest line) exceeds the box; if so, show a
subtle amber outline / small "overflowing — enlarge the box" hint. Purely advisory (no layout change).

**Maps to reported issues:** #1 (widen doesn't un-wrap) → wrap uses the box width, no fit override; #2 (size
fixed) → A+/A− authoritative, no fit override; #3 (spaces) → whitespace-preserving wrap.

**Tests & verify**
- Unit: `wrapTextToLines` preserves blank lines + spaces; wider width ⇒ fewer lines; larger font ⇒ same text
  emitted at the larger size; overlap detection returns true when content exceeds the box.
- **Browser:** widen the box → lines merge upward; A+ → text visibly grows; type "a␣␣␣b" and blank lines →
  preserved; shrink the box → overlap warning appears; enlarge the box → overlap clears; re-tap an edited
  block → re-opens; Export → matches the box.

**Commit:** feature-side (editor + `textLayout` + emission + covers). Folds into the Phase 1 feature commit;
no export-path (`handlers`) change.

### Task 10E — Text edit: auto-height (never hide text) + remove the overflow warning  ✅
**Goal:** fix two problems from the 10D build — (1) the "Overflowing — enlarge the box" **warning blocks the
view while writing**; (2) when typed text wraps past the box, the extra text is **hidden** until the box is
enlarged (e.g. type "Travel Itinerary" and "Itinerary" disappears) — so the user can't tell what they typed
and may type it twice.
**This SUPERSEDES 10D's overflow-warning + manual-height behaviour.** New rule: **width is manual, height is
automatic.** The editor grows to show ALL text; widening the box re-wraps it back up (enough width → one
straight line). No warnings.
**Depends on:** Task 10D.
**Done when:** while typing, all text is always visible (box auto-grows, nothing hidden/clipped); dragging
the width wider re-flows wrapped text upward and, if it fits, onto one line; **no warning appears anywhere**;
re-edit / move / whitespace still work; tests/typecheck/lint green.

**Decisions locked (from the user):**
- **Remove the overflow warning entirely** — no amber hint, no banner, nothing over the text.
- **Height auto-fits content** — the edit box grows/shrinks vertically to fit the wrapped lines, so typed
  text is **never hidden or clipped** while editing. **Remove the manual height handle** added in 10D.
- **Width stays a manual drag**; text wraps to the box width; **widening re-wraps to fewer lines** (enough
  width ⇒ a single straight line).
- **Font size stays manual** (no auto-shrink) — unchanged from 10D.
- If the auto-height block ends up taller than its original area, it **silently overlaps** the content below
  (accepted — no warning). Keep per-line local-colour covers, re-edit, and move.

#### Workflow

**1 — Remove the warning → `TextEditOverlay.tsx` / `OverlayLayer.tsx`**
Delete the "Overflowing — enlarge the box" amber outline/hint and any overflow-detection state driving it.

**2 — Auto-growing editor (the core fix) → `TextEditOverlay.tsx`**
The `<textarea>` currently has a **fixed height** (`editorHeight`) with `overflow-auto`, which clips/hides
wrapped lines below the fold. Instead, **auto-resize the textarea to its content**: on every input (and when
width or font size changes), set its height to `scrollHeight` so every line is visible. Remove the fixed
height and the manual height-drag handle. Keep the width-drag; the textarea keeps `white-space: pre-wrap` so
it wraps to the current width — dragging wider reduces the line count automatically.

**3 — Committed overlay + export follow the wrapped content → `OverlayLayer.tsx` / `buildTextEdits.ts`**
Height is derived from the wrapped line count at the current width + font (already how per-line emission
works). Ensure the on-screen committed overlay is **not clipped** (no fixed/`overflow-hidden` height that
hides lines) and the export draws every wrapped line. Drop any remaining shrink-to-fit / fixed-height clamp.

**4 — Widen ⇒ re-wrap (verify it flows to one line)**
Because wrapping is driven by the box width, dragging the width wider must re-run wrapping and shrink the
auto-height accordingly. Confirm "Travel Itinerary" that wrapped at a narrow width collapses to one line when
widened — with the word always visible throughout.

**Tests & verify**
- Unit (already have wrap tests): wider width ⇒ fewer lines; whitespace/blank lines preserved.
- **Browser:** type text longer than the box → it wraps and **stays fully visible** (box grows); no warning
  appears; drag width wider → wrapped words flow back onto one line; the word never disappears at any width;
  Export matches what's shown.

**Commit:** feature-side (editor + overlay + emission). Folds into the Phase 1 feature commit; no export-path
(`handlers`) change.

### Task 11 — Tap popover shell + Search Google / Maps  🔲
**Goal:** the shared popover, with the no-AI actions live.
**Deliverables:** `components/TapPopover.tsx` — **Edit** + **Search Google** (`meaning of <selection>`,
new tab, only the selected snippet in the URL) + **Open in Maps**
(`google.com/maps/search/?api=1&query=<selection>`, for place/state names); Translate/Meaning slots
present but disabled.
**Depends on:** Task 8.
**Note (Feature A — "what is this place?"):** This popover *is* Feature A. "Open in Maps" is the only new
piece; **Search Google** (here) and **Meaning** (Task 21, AI `explain()` → "X is a state in…") cover the
rest. No AI needed for Search/Maps; only the tapped snippet leaves the device.

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

---

## Feature 6 — Smart dates → calendar & places → maps  (reader-layer add-on)

> **Not an edit feature.** Like Translate/Voice, these *read* the document and offer an action — they emit
> **no `Edit`** and **never touch the export seam**, so "layout never shifts" is unaffected and nothing is
> added to the exported PDF. Fully client-side.
>
> **Places → Maps** is already folded into **Task 11** above (Feature A). The new work below is **dates →
> calendar** (Tasks 31–33).
>
> **Scheduling:** depends only on **Task 8** (text extraction) + the **Task 11** popover pattern — it's
> independent of the Indic/image/translate/voice work. Build it **after Phase 1**, ship it **before/with
> the Phase 6 deploy**. (Numbered 31–33 to avoid renumbering; order is by dependency, not by number.)
>
> **Decisions locked:** "Set Reminder" = **calendar event with an alarm** (the web can't set a native OS
> alarm). Calendar mechanism = **Add to Google Calendar** link (with an optional `.ics` fallback).

### Task 31 — Date/time detection over document text  🔲
**Goal:** find date/time strings and their positions in the page text.
**Deliverables:** `lib/smart/dateDetect.ts` — scan `getTextContent()` runs for common formats
(`23 Aug 2026`, `12/08/2026`, `15–23 Aug`, `3pm`, ranges) → `{ raw, start, end?, allDay, pageIndex, rect }[]`.
Ambiguous `DD/MM` defaults to **day-month** (Indian convention). Regex-based (optionally `chrono-node`).
**Depends on:** Task 8.
**Done when:** unit tests parse the sample itinerary's dates — including the `12 Aug – 23 Aug` range — correctly.

### Task 32 — Smart-date span overlay + confirm popover  🔲
**Goal:** make detected dates tappable and confirmable before acting (parsing can misread — never auto-create).
**Deliverables:** `components/SmartSpanLayer.tsx` — tappable highlights positioned via `coordinates.ts`;
`components/DateActionPopover.tsx` — shows the parsed date + an **editable title** (defaulted from nearby
text, e.g. "Travel: 12–23 Aug") + a **day-month / month-day toggle** for ambiguous dates.
**Depends on:** Task 31, Task 3.

### Task 33 — Calendar action (Google Calendar + alarm)  🔲
**Goal:** turn a confirmed date into a calendar event / reminder.
**Deliverables:** `lib/smart/calendarLink.ts` —
- **Add to Google Calendar** → open
  `https://calendar.google.com/calendar/render?action=TEMPLATE&text=<title>&dates=<START>/<END>&details=<snippet>&location=`
  in a new tab (timed `…THHMMSSZ` or all-day `YYYYMMDD` ranges).
- **Set Reminder** → the same event; the alarm is Google Calendar's **default notification** (= the agreed
  "calendar event with an alarm").
- *Optional secondary:* a downloadable **`.ics`** (`VEVENT` + `VALARM`) for a precise "N days before" alarm,
  offline use, or non-Google calendars.
**Depends on:** Task 32.
**Done when:** tapping a date in the sample PDF → confirm → **Google Calendar opens pre-filled** with the
correct date + title.
