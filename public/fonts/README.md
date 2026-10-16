# Local editing fonts — Task 78

Every font in this directory is distributed under **SIL OFL 1.1**. The full
copyright notices and licence are beside each family in `OFL.txt`. `SOURCES.json`
records each binary's original official URL, pinned revision and SHA-256.
No proprietary PDF font has been copied into these assets. No Caladea is shipped.

| Directory | Original project / release |
| --- | --- |
| carlito | Google Fonts Carlito (Calibri metric twin) |
| lato | Google Fonts Lato |
| allura | Google Fonts Allura |
| opensans | googlefonts/opensans |
| ibmplexsans | IBM/plex |
| leaguespartan | theleagueof/league-spartan, 2.x |
| leaguespartan-legacy | theleagueof/league-spartan, 1.000 release / font version 0.11 |
| notosans | notofonts/noto-fonts |
| sourcesanspro | adobe-fonts/source-sans, 2.045R-ro/1.095R-it (Source Sans Pro) |
| bricolagegrotesque | ateliertriay/bricolage |
| liberation | Liberation 2.1.5: Sans, Serif and Mono |
| r1width | Renamed horizontal-width derivatives of Liberation 2.1.5 |

The `r1width` fonts are rebuilt with `scripts/task78-width-fonts.py` (fontTools).
They are named **R1WidthSans**, **R1WidthSerif**, **R1WidthMono**, not a reserved
original font name. Their height is unchanged; a `wdth` axis uniformly scales X
outlines and advances from 50–200%. Native browser layout uses this width axis;
PDF export uses the corresponding unmodified static Liberation font with an
X-only graphics transform. Original and derivative copyright/licences are kept.

The application fetches only active page/style assets from its own `/fonts/`.
Nothing here contacts a public font CDN. Fontkit is a separate lazy export chunk;
font subsetting does not change the licence of exported documents.

Export aligns glyph records in an in-memory TrueType copy before fontkit
subsetting. This avoids fontkit 1.1.1's short-`loca` rounding defect on the
original Carlito files (which legally use odd byte offsets). Shipped files,
outlines and advances are unchanged. Regression tests compare all 95 printable
ASCII outlines/advances in all four Carlito styles after subsetting.

Reproduce the original-source audit with `scripts/task78-font-assets.mjs`.
Install reviewed sources with `scripts/task78-install-fonts.mjs`; review the
separate original Spartan licence before `task78-spartan-release.mjs --install`.
After building width derivatives, run `task78-asset-manifest.mjs` to check sizes
and publish the complete binary manifest. Updating an upstream revision requires
a new licence review and width regression run; a family name alone is not proof
that two releases have the same advances.
