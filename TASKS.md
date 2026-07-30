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

### Task 6 — Verification harness (round-trip)  🔲
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
