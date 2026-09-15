# Task 66 — clean text reading

The editor, Ask, and read-aloud now consume the same cleaned `extractTextRuns` output. Exact same-position copies are removed with the later paint-order copy retained. Old words under later opaque rectangle covers are removed from reading, without changing the exported PDF bytes.

## Verification

| Check | Result |
|---|---:|
| Local PDFs enumerated | 43 |
| Pages read (at most 20 per PDF) | 235 |
| Three-generation re-edit targets passed | 105 / 105 |
| Untouched lines changed | 0 |
| Reading-pattern flags | 4 (both Ladakh files, two each) |
| Files that cannot be opened | 7 (broken/random/locked repair samples) |
| Image-only PDFs without extractable text | 8 |
| File with no safe isolated test target | 1 (`delhi-tour.pdf`, overlapping lettering) |

The four Ladakh flags are offset shadow copies, not exact same-position copies. One measured heading copy is shifted about 2.8 pt horizontally and 2.1 pt vertically at 46.9 pt; Task 66's 3% tolerance is about 1.4 pt. This is the documented visible-offset limit. The sweep deliberately does not edit a target whose cover would overlap a separate visible line.

Whole-document GOA 2026 extraction measured 429.3 ms before the opaque-cover filter and 443.5 ms after it in separate, single-test runs (1.03×, below the 1.5× sharing threshold). Both reads returned 8,146 marked characters across 16 pages.

| PDF | Pages | Flags | Re-edits | Untouched changes | Note |
|---|---:|---:|---:|---:|---|
| `bullets/RAHUL_RAJPUT_RESUME-edited__2_.pdf` | 2 | 0 | 4/4 | 0 | |
| `bullets/RAHUL_RAJPUT_RESUME.pdf` | 2 | 0 | 4/4 | 0 | Untouched extraction kept all text items |
| `bullets/Rahul_Resume.pdf.pdf` | 1 | 0 | 2/2 | 0 | |
| `bullets/Rahul_Resume.pdf__1_.pdf` | 2 | 0 | 4/4 | 0 | |
| `compress-tests/cv-signed-compressed.pdf` | 2 | 0 | 5/5 | 0 | |
| `compress-tests/cv-signed.pdf` | 2 | 0 | 5/5 | 0 | |
| `compress-tests/healing.pdf` | 19 | 0 | 6/6 | 0 | |
| `compress-tests/images__2_-compressed.pdf` | 4 | 0 | — | 0 | No extractable text |
| `compress-tests/images__2_-compressed__1_.pdf` | 4 | 0 | — | 0 | No extractable text |
| `compress-tests/images__2_.pdf` | 4 | 0 | — | 0 | No extractable text |
| `compress-tests/images__2__compressed.pdf` | 4 | 0 | — | 0 | No extractable text |
| `compress-tests/images__3_-compressed.pdf` | 3 | 0 | — | 0 | No extractable text |
| `compress-tests/images__3_.pdf` | 3 | 0 | — | 0 | No extractable text |
| `compress-tests/images__3__compressed.pdf` | 3 | 0 | — | 0 | No extractable text |
| `compress-tests/images__3__compressed__1_.pdf` | 3 | 0 | — | 0 | No extractable text |
| `compress-tests/ladakh-original.pdf` | 20 | 2 | 4/4 | 0 | Offset shadows flagged |
| `compress-tests/ladakh.pdf` | 20 | 2 | 4/4 | 0 | Offset shadows flagged |
| `compress-tests/rishi-ilovepdf.pdf` | 2 | 0 | 7/7 | 0 | |
| `compress-tests/rishi-signed.pdf` | 2 | 0 | 7/7 | 0 | |
| `pdfs/task52-merge-qa/form-1.pdf` | 1 | 0 | 1/1 | 0 | Trailing annotation appearance handled |
| `pdfs/task52-merge-qa/form-2.pdf` | 1 | 0 | 1/1 | 0 | Trailing annotation appearance handled |
| `pdfs/task52-merge-qa/forms-merged.pdf` | 2 | 0 | 2/2 | 0 | |
| `pdfs/task52-merge-qa/sample-goa-merged.pdf` | 20 | 0 | 5/5 | 0 | |
| `pdfs/task53-split-qa/GOA 2026-pages-1-8.pdf` | 8 | 0 | 4/4 | 0 | |
| `pdfs/task53-split-qa/GOA 2026-pages-9-16.pdf` | 8 | 0 | 3/3 | 0 | |
| `repair-tests/1-healthy-GOA.pdf` | 16 | 0 | 4/4 | 0 | |
| `repair-tests/2-broken-index.pdf` | — | — | — | — | Invalid PDF |
| `repair-tests/3-stopped-download.pdf` | — | — | — | — | Invalid PDF |
| `repair-tests/3b-stopped-download-90.pdf` | — | — | — | — | Invalid PDF |
| `repair-tests/4-web-page-saved-as-pdf.pdf` | — | — | — | — | Invalid PDF |
| `repair-tests/5-random-bytes.pdf` | — | — | — | — | Invalid PDF |
| `repair-tests/6-locked.pdf` | — | — | — | — | Password required |
| `repair-tests/7-signed-healthy.pdf` | 2 | 0 | 2/2 | 0 | |
| `repair-tests/8-signed-broken-index.pdf` | — | — | — | — | Invalid PDF |
| `sign-tests/crop-offset.pdf` | 1 | 0 | 1/1 | 0 | |
| `text-doubling/corporate-edited-3.pdf` | 20 | 0 | 5/5 | 0 | New university line reads once |
| `text-doubling/delhi-tour.pdf` | 10 | 0 | — | 0 | Text lines overlap; no safe isolated target |
| `text-doubling/healing.pdf` | 19 | 0 | 6/6 | 0 | |
| `text-doubling/rahul-rajput-edited.pdf` | 2 | 0 | 5/5 | 0 | Edited bullet does not glue old text |
| `text-doubling/rishi-edited.pdf` | 2 | 0 | 7/7 | 0 | Name reads “Utkarsh Taneja” once |
| `text-doubling/sejda-after.pdf` | 1 | 0 | 2/2 | 0 | |
| `text-doubling/sejda-before.pdf` | 1 | 0 | 2/2 | 0 | |
| `text-doubling/ziro.pdf` | 19 | 0 | 3/3 | 0 | Title and document text have no doubled letters |

The sweep is local-only and can be repeated with `TASK66_SWEEP=1 npm test -- --run src/lib/pdf/reeditSweep.local.test.ts` (set the environment variable using the host shell's syntax). CI skips it when the personal PDFs are unavailable. The source files under `tmp/` were not modified or deleted.

## Live check on port 5173

At `http://127.0.0.1:5173/app`, the Rishi sample opened with exactly `Utkarsh Taneja` in the name edit box. Three edit–export–reopen generations then showed `Task 66 One`, `Task 66 Two`, and `Task 3` once each in the reopened edit box. A longer third label wrapped visually across two lines, so the final same-line check used the shorter `Task 3` label. Ziro's page-one title edit box showed exactly `ZIRO FESTIVAL`, and page two exposed `ZIRO FESTIVAL FOR US?` without doubled letters. The Corporate Governance page-four replacement edit box contained the new `Universities and I'm going for the bath` wording without the old `Universities. Universities` repeat. The local UI test created exported copies in Downloads and saved test projects in the browser; it did not modify the source PDFs under `tmp/`.
