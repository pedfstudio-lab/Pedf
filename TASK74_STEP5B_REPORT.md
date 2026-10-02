# Task 74 Step 5b — implementation and validation

Branch: `live-page-preview`, based on `main` commit `603b16a`.
Status: implemented for review; not merged. Development server: http://127.0.0.1:5173/.

## Behaviour

- A one-page exporter shares the full export's glyph removal, satisfied-cover handling, fonts and drawing handlers. It resolves the live page plan, including reordered, duplicated, rotated, cropped and blank pages.
- PageCanvas prepares replacement pixels offscreen, swaps a completed canvas, and ignores stale completions. The original offscreen raster remains the sampling source.
- Opening text mounts and focuses the real contenteditable immediately. Preparation hides glyph paint while retaining native input, caret, selection and composition. The same DOM becomes transparent editing or the legacy fallback.
- A changed Done uses the existing edit builder and replacement call. The DOM remains until the committed canvas is ready. Rendering failure retains the saved edit and reveals the original canvas plus legacy overlays.
- Cancel and unchanged Done restore the retained idle canvas without editing history. Typing does not trigger exports. Preview state never enters projects or autosave.
- A lazy worker receives one transferred copy of pristine bytes and shares parsed source resources across nearby pages. Completed previews have a bounded cache; queued obsolete requests are skipped. Temporary PDF.js readers are destroyed. The worker/source is released with the last page.
- Existing picture patches, free-text editing and geometry builders remain. Inline date/location actions retain hit targets while their glyph paint belongs to the canvas.

## Automated evidence

- Page preview tests check active replacement omission, unrelated edits, unmodified input bytes, live page mapping, eligibility refusals and exact full-export pixels. A text-glyph bullet list removes both markers and items; image-marker lists use the required fallback.
- PageCanvas tests check delayed swaps, cancellation, unchanged committed restoration, retained editors through commit, failure with preserved edits, stale zoom work and unrelated-page updates.
- DOM tests retain the same focused editor, text and selection across preparing/clean/fallback transitions using `English नमस्ते தமிழ்`. These are simulated composition tests, not a real browser/IME certification.
- Worker-service tests check lazy creation, initialization and preparation deduplication, prohibited-worker fallback, closure during pending work, shared ownership and idempotent release.
- `TASK74_PREVIEW=1` passed over the 45-file baseline plus four explicit cases: 39 clean selections had pixel-identical editing and committed previews compared with the corresponding full export. Nine files had no matching extracted text target. One Rahul list cover also replaces an image and was refused with that reason. Each clean re-edit was also checked against full export with its replacement omitted.
- `TASK74_REAL`, `TASK72_REAL`, `TASK66_SWEEP`, `TASK70_TABLES` and `TASK74_PATCH` were enabled together: 1,365 tests passed, 17 skipped, and one pre-existing count assertion failed. The patch checks accounted for all 335 covers across 45 files: all satisfied covers skipped, no unreasoned drawn cover, no refused page. The re-edit sweep reported 121 round trips passed and zero failures across 47 files/242 pages.
- The failing `neighbourBoxWidth.test.ts` corpus assertion expects 475 non-left units but observes 416. An untouched archive of `main` reproduced the same failure on the same fixtures (`tmp/5b-main-neighbour.log`). Its expected counts were not changed to make this branch pass.
- The final standard suite passed: 1,348 tests passed, 39 skipped (165 suites passed, 15 skipped). Typecheck, lint and production build passed. The existing build chunk-size warning remains.

## Timing

These measurements use PDF.js legacy and native canvas in Node on this machine. They separate costs but do not certify browser latency. The initial measurements preceded the cache/worker implementation.

| File / zoom | Cold source + operators | Copy/tree/rewrite/save | Reopen + render |
|---|---:|---:|---:|
| Goa / 0.5 | 227 ms | 74 ms | 482 ms |
| Goa / 1 | 151 ms | 35 ms | 391 ms |
| Goa / 2 | 133 ms | 54 ms | 685 ms |
| Bhutan 61.2 MB / 0.5 | 4,501 ms | 4,410 ms | 4,703 ms |
| Bhutan / 1 | 4,788 ms | 4,302 ms | 4,616 ms |
| Bhutan / 2 | 4,465 ms | 4,023 ms | 5,411 ms |

The Node worker feasibility check ran pdf-lib and PDF.js legacy successfully. Bhutan structured clone took 80.6 ms wall time with 27.9 ms maximum sampled main-thread delay. Transfer took 2.7 ms with zero sampled delay. Worker source parsing took 5,100 ms wall time with 17.7 ms maximum sampled main-thread delay. This supports moving source parsing/rewrite off the UI thread; it does not imply faster total completion. The pristine buffer is copied once before transfer, and that copy still runs on the main thread.

With page-shared source resources warm, Goa preparation plus rendering measured 188–516 ms. Bhutan measured 4,239–5,006 ms at 0.5/1/2 zoom: **the 100 ms target is missed when only page-shared work is warm**. Completed block-specific cache hits measured 0.27–0.61 ms for Bhutan; this excludes browser canvas copy and paint. `Preparing text…` remains visible while the real editor retains input. Browser worker feasibility, actual focus latency, canvas-swap latency and native IME behaviour remain unverified.

Raw local artifacts: `tmp/5b-timing-baseline.log`, `tmp/5b-warm-timing.json`, `tmp/5b-preview-corpus.json`, `tmp/5b-preview-corpus.log`, `tmp/5b-all-tests.log`, `tmp/5b-main-neighbour.log`, `tmp/5b-final-suite.log`, `tmp/5b-typecheck.log`, `tmp/5b-lint.log`, `tmp/5b-build.log`.

## Remaining review

Browser access to the separate test server on port 5174 was declined. That extra server was stopped and normal development restored on 5173. The user then explicitly authorized verification of the existing 5173 tab. The browser tool still rejected binding that tab: its URL policy reported an unsupported protocol despite the requested URL using HTTP. No workaround or alternate browser was attempted. Browser verification remains blocked by the tool, rather than by missing user authorization.

Before merging, complete the Task 74 manual workflow on Bhutan, a wrapping paragraph, a bordered cell and a list: unchanged Done, changed Done, re-edit, Undo/Redo, zoom/DPR and reopening a saved project. Verify photo/fill/border pixels, immediate focus and composition during preparation, and the production worker path. Resolve or explicitly accept the pre-existing corpus count failure. Step 5c's frame and toolbar placement remain separate work.
