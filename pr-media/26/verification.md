# Article header regression evidence — PR #26

## Result

**24/24 paired layout cases pass.** Four previously broken cases are fixed; 20 unaffected cases retain identical measured geometry. All 10 unaffected desktop/mobile screenshot pairs are byte-identical.

## Method

- Baseline: `9f3ecf8671ddf25e28662b6a278a1e54216924f9`. Fix: `8192de16ef4fe584416a3be3748a9adb8a46102c`.
- Real compiled Express application served from the repository root at `http://127.0.0.1:4317`; screenshots captured through the Codex in-app Chromium browser.
- Identical synthetic content, source metadata, locale (Dutch), and viewports before/after. Only the four-line CSS rule was changed. The real rendering functions were used; no DOM or screenshot mockups.
- Source fixtures: Google Drive recording without artwork; Spotify podcast with artwork; YouTube video with artwork and a longer title/source name. The existing application icon stands in for artwork.
- Each source was tested in owner and anonymous shared readers at 1440×1000, 801×1000, 800×1000, and 390×844.
- Assertions compare header/title/artwork/source-label/metadata/article geometry and action labels/display; validate full-width text or the expected cover/text split, successful image loading, and no document overflow.
- At 1440px the missing-artwork title expands from 140px to 1209.625px; at 801px it expands from 140px to 672.84375px. Mobile layout remains unchanged.
- Viewport dimensions and screenshots were inspected; two initial captures taken during viewport settling were discarded and recaptured at 390×844 before comparison.
- All test fixtures were removed and the temporary server stopped. Production article data was not read or modified.

## Paired layout matrix

| Reader | Source | Viewport width | Title width before → after | Result |
| --- | --- | ---: | ---: | --- |
| Owner | google-drive | 1440px | 140.000 → 1209.625px | PASS — Fixed |
| Owner | google-drive | 801px | 140.000 → 672.844px | PASS — Fixed |
| Owner | google-drive | 800px | 756.000 → 756.000px | PASS — Unchanged |
| Owner | google-drive | 390px | 346.000 → 346.000px | PASS — Unchanged |
| Shared | google-drive | 1440px | 140.000 → 1209.625px | PASS — Fixed |
| Shared | google-drive | 801px | 140.000 → 672.844px | PASS — Fixed |
| Shared | google-drive | 800px | 756.000 → 756.000px | PASS — Unchanged |
| Shared | google-drive | 390px | 346.000 → 346.000px | PASS — Unchanged |
| Owner | spotify | 1440px | 1034.625 → 1034.625px | PASS — Unchanged |
| Owner | spotify | 801px | 497.844 → 497.844px | PASS — Unchanged |
| Owner | spotify | 800px | 756.000 → 756.000px | PASS — Unchanged |
| Owner | spotify | 390px | 346.000 → 346.000px | PASS — Unchanged |
| Shared | spotify | 1440px | 1034.625 → 1034.625px | PASS — Unchanged |
| Shared | spotify | 801px | 497.844 → 497.844px | PASS — Unchanged |
| Shared | spotify | 800px | 756.000 → 756.000px | PASS — Unchanged |
| Shared | spotify | 390px | 346.000 → 346.000px | PASS — Unchanged |
| Owner | youtube | 1440px | 1034.625 → 1034.625px | PASS — Unchanged |
| Owner | youtube | 801px | 497.844 → 497.844px | PASS — Unchanged |
| Owner | youtube | 800px | 756.000 → 756.000px | PASS — Unchanged |
| Owner | youtube | 390px | 346.000 → 346.000px | PASS — Unchanged |
| Shared | youtube | 1440px | 1034.625 → 1034.625px | PASS — Unchanged |
| Shared | youtube | 801px | 497.844 → 497.844px | PASS — Unchanged |
| Shared | youtube | 800px | 756.000 → 756.000px | PASS — Unchanged |
| Shared | youtube | 390px | 346.000 → 346.000px | PASS — Unchanged |

## Original screenshot pairs

The 10 unaffected pairs below are identical JPEG files, confirmed with byte comparison and SHA-256. The two desktop pairs without artwork intentionally differ.

| Reader | Source | Viewport | Before | After | Exact match |
| --- | --- | --- | --- | --- | --- |
| Owner | google-drive | 1440×1000 | [Before](before-owner-google-drive-1440.jpg) | [After](after-owner-google-drive-1440.jpg) | No — intended fix |
| Owner | google-drive | 390×844 | [Before](before-owner-google-drive-390.jpg) | [After](after-owner-google-drive-390.jpg) | Yes |
| Shared | google-drive | 1440×1000 | [Before](before-shared-google-drive-1440.jpg) | [After](after-shared-google-drive-1440.jpg) | No — intended fix |
| Shared | google-drive | 390×844 | [Before](before-shared-google-drive-390.jpg) | [After](after-shared-google-drive-390.jpg) | Yes |
| Owner | spotify | 1440×1000 | [Before](before-owner-spotify-1440.jpg) | [After](after-owner-spotify-1440.jpg) | Yes |
| Owner | spotify | 390×844 | [Before](before-owner-spotify-390.jpg) | [After](after-owner-spotify-390.jpg) | Yes |
| Shared | spotify | 1440×1000 | [Before](before-shared-spotify-1440.jpg) | [After](after-shared-spotify-1440.jpg) | Yes |
| Shared | spotify | 390×844 | [Before](before-shared-spotify-390.jpg) | [After](after-shared-spotify-390.jpg) | Yes |
| Owner | youtube | 1440×1000 | [Before](before-owner-youtube-1440.jpg) | [After](after-owner-youtube-1440.jpg) | Yes |
| Owner | youtube | 390×844 | [Before](before-owner-youtube-390.jpg) | [After](after-owner-youtube-390.jpg) | Yes |
| Shared | youtube | 1440×1000 | [Before](before-shared-youtube-1440.jpg) | [After](after-shared-youtube-1440.jpg) | Yes |
| Shared | youtube | 390×844 | [Before](before-shared-youtube-390.jpg) | [After](after-shared-youtube-390.jpg) | Yes |

## Checks and audit files

- `npm run format` — passed; no unrelated files changed.
- `npm run check` — passed (formatting, ESLint, TypeScript build, 166 Vitest tests, 5 webhook tests). The existing localhost test required execution outside the filesystem/network sandbox.
- `node --check public/app.js` and `node --check public/share.js` — passed.
- `git diff --check` — passed.
- [Raw DOM measurements](measurements.json), [paired comparison results](comparison-results.json), [screenshot SHA-256 checksums](SHA256SUMS.txt).

## Scope and limitations

This was an ad hoc browser regression run, not a newly installed CI visual-test suite. It covers the listed representative fixtures and Chromium viewports, not every stored article, Safari/Firefox, native devices, or print rendering. Existing unit tests do not assert CSS layout. No audio playback or external source requests were exercised. No interaction or motion changed, so static screenshots are the relevant visual evidence.

Evidence is stored on the long-lived `assets` branch under `pr-media/26/`, separate from the feature branch and PR diff.
