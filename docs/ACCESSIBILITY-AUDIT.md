# Accessibility review: 19 September 2026

The contrast and article-action naming failures recorded in
[issue #31](https://github.com/rogierslag/podcast2article/issues/31) no longer
reproduce in the checked states. This review also found and repaired text-spacing
overflow, low-contrast artwork placeholders, and incomplete names for reading
continuation and numbered article links. It does not establish WCAG 2.2 AA
conformance for the whole product.

The review started from `main` at `0239d8e`. PR preparation rebased
`codex/brand-journey-review` onto `c091ba6`, including the Node 24 tooling update,
and repeated the complete repository and browser checks. The earlier fixes from
PRs #55 and #58 were part of the starting point, not assumed to complete the review.

## Scope and evidence

The compiled local application ran with authentication enabled. Checks used a
separate test account, a representative four-section article, a transcript, and
a short test audio file. Processing, read-state failures, and series data were
intercepted in the browser; no paid generation requests were made.

| Check                                          | Coverage                                                                                                                                   | Result                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| axe-core 4.13.0                                | Chromium at 1440 × 1000 and WebKit at 390 × 844; Dutch/English; light/dark; 15 states per combination                                      | 120 final scans, no reported violations                                                                                  |
| Follow-up checks after the last naming changes | Shared reader with a saved local reading position and numbered library links in the same eight combinations                                | 16 additional scans, no reported violations; visible labels and destination text retained                                |
| Version-text semantics                         | Login and login error in both engines, languages, and themes                                                                               | 16 additional scans, no reported violations or unsupported ARIA naming                                                   |
| Reflow and text spacing                        | Both engines, languages, and themes; login at 320px; home, library, populated series, owner article, and shared article at 320px and 390px | 88 page cases, each checked with normal and increased spacing; no final page/component overflow or detected clipped text |
| Keyboard and focus                             | Login, home and series navigation; source dialog opening, dismissal and return; reading continuation; processing recovery                  | Sampled controls remained reachable; continuation focused its destination; source dismissal restored the opener          |
| Target spacing                                 | Enabled links, buttons, inputs, selects and summaries in the main state matrix                                                             | No conflicts found by the 24px target/spacing geometry check, with inline links treated separately                       |

The 15 scanned states were login, login error, home, library, series, owner
article, read state, read-state error, source dialog, saved owner reading
position, processing, unavailable processing status, failed article generation,
failure without a reusable transcript, and anonymous shared reading.

Text-spacing overrides applied line height of 1.5, letter spacing of 0.12em,
word spacing of 0.16em, and paragraph spacing of 2em. The 320px checks exercise
the layout width used by the [reflow criterion](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html);
they are not a substitute for physical-device zoom testing. The spacing values
follow [SC 1.4.12](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html).

Screenshots were inspected for normal desktop/mobile pages, dark reading and
recovery states, and the affected narrow layouts with spacing overrides.
Raw audit results and screenshots were captured outside the repository under
`/tmp/podcast2article-accessibility-audit/`: `results/` contains the initial
88-state scan, `final/` the 120-state matrix, `targeted/` the final naming
checks, and `reflow/` the final spacing checks. These are local review artifacts,
not production files or a permanent hosted evidence archive.

## Findings and repairs

The original issue's small orange text now uses `--accent-text`; ordinary muted
text and control boundaries use the corrected theme roles. The login version
text has full opacity. Representative checked combinations are:

| Combination                                  | Light  | Dark                              | Threshold |
| -------------------------------------------- | ------ | --------------------------------- | --------- |
| Small orange text on the main cream surface  | 5.59:1 | Above 4.5:1 in the checked states | 4.5:1     |
| Muted text on the main cream surface         | 5.05:1 | Above 4.5:1 in the checked states | 4.5:1     |
| Login version text on its panel              | 5.65:1 | 6.40:1                            | 4.5:1     |
| Empty login input boundary against its panel | 4.24:1 | 3.71:1                            | 3:1       |

Ratios are calculated from the foreground/background colors, not antialiased
pixels. The regression checks compare unrounded ratios to the thresholds.

This pass repaired these additional cases:

- **Artwork fallback numbers:** light-mode `#b9d2c7` on `#376453` measured
  4.21:1. Changing the text role to `#cee1d7` raises this to 4.94:1. The palette
  test now includes this combination.
- **Reading continuation:** owner and shared readers overrode the visible
  phrase and section title with a different `aria-label`. Both buttons now use
  their visible content as their accessible name. Keyboard activation still
  moves focus to the saved section. The shared-reader case uses local storage.
- **Numbered article links:** a fallback cover displaying `01` previously had
  only the article title in its accessible name. The link name now includes
  that number as well as the reading action and title.
- **Shared header semantics:** removed an unnecessary `aria-label` from a
  generic span. The visible product name already identifies the brand.
- **Login build metadata:** manual review also found an unsupported `aria-label`
  on the build paragraph. The visible localized version and short revision
  remain ordinary text; the optional full revision moves to `title` in both
  server rendering and client localization. The tooltip is supplementary
  metadata, not the only way to obtain information needed for a task.
- **Increased text spacing at 320px:** long headings and minimum-content sizing
  expanded the login, home, library, or transcript beyond the viewport. Scoped
  wrapping and size constraints keep those components within the page. WebKit
  also needed native select contents contained within the control, and article
  action groups needed to wrap within the card. Ordinary desktop and 390px
  layouts retain their type sizes.

Read, PDF, and link-copy actions retained their visible labels in both languages
at the top and bottom of the article, including the pending, read, and error
states. Mobile icon-only actions retained their accessible names. These checks
address [Label in Name](https://www.w3.org/WAI/WCAG22/Understanding/label-in-name.html);
actual voice-control activation remains a separate check.

## Manual review of automated warnings

- The orange `2` in the product wordmark was flagged for contrast review.
  It belongs to the brand name, covered by the logotype exception in
  [SC 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
  This exception does not extend to orange utility text.
- The submit arrow is decorative and accompanies a readable action label.
- The faint dots between the login maker links are decorative separators,
  already hidden from assistive technology. Each adjacent link has its own
  readable text; the dots carry no additional information and fall under the
  decorative-content exception to text contrast.
- The login build paragraph's unsupported ARIA label was a real markup issue,
  rather than an exception. It was addressed as described above; a native
  paragraph does not need an overriding accessible name.
- Select background SVGs prevented axe from automatically determining their
  background. The checked text/surface combinations measured 15.56:1 in light
  mode and 12.83:1 in dark mode. The native option popup remains platform-owned;
  long selected values can be shortened in the closed control.
- Some navigation links are shorter than 24px high. The geometry check found
  sufficient separation under the spacing exception in
  [SC 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
  This is not a claim that every target is 24px or 44px square.
- In WebKit, tabbing through native audio controls could move focus into browser
  chrome before returning to the modal. `document.hasFocus()` was false during
  that step; focus did not move to an interactive control behind the dialog.

## Regression coverage

`scripts/accessibility.node-test.mjs` checks the relevant text, placeholder,
highlight, and control-boundary color combinations. The focused node tests
passed during this review.

`scripts/browser/accessibility.browser.mjs` covers both languages and themes,
repeated article actions through state changes, login version opacity, numbered
cover names, owner/shared continuation names and keyboard destinations, and
320px reflow with increased text spacing. Existing reader and interaction tests
cover dialog behavior, source seeking, button feedback, and reduced-motion
styles. The final combined branch passed 369 Vitest tests, 54 Node tests, and
156 browser tests across Chromium and mobile WebKit, along with formatting,
lint, build, frontend syntax, and diff checks. Reproduce these checks with:

```sh
npm run check
npm run test:browser
node --check public/app.js
node --check public/share.js
git diff --check
```

Final branch verification passed: `npm run check` completed with 369 Vitest
tests and 54 Node tests, and the browser suite passed all 156 checks across
Chromium and WebKit, including the new naming, spacing, and recovery cases.
The temporary preview and browser-test servers were stopped and the test fixture
was removed after verification.

## Remaining verification

The known failures have fixes and regression coverage. Issue #31's wider manual
verification must not be treated as complete based on these results alone.
Still required before any product-wide conformance claim:

- VoiceOver/NVDA reading order, announcements, landmarks, errors, progress,
  dialogs, native audio controls, and document exports with assistive technology.
- Voice Control or equivalent activation using the visible Dutch and English
  action labels.
- Browser zoom and text-only zoom, mobile pinch zoom, operating-system text
  scaling, the on-screen keyboard, and native select/share sheets on real devices.
- A full keyboard and focus-obstruction review beyond the sampled paths, along
  with forced-colors/high-contrast modes and additional supported browsers.
- Recording-specific transcript accuracy and equivalence, caption or audio
  description needs, generated article structure, PDF accessibility, and other
  applicable media/content criteria. A quiet fixture cannot establish those.

The audit checked representative rendered states and interactions. Automated
passes, a corrected color palette, and these screenshots do not establish that
every applicable accessibility criterion has been assessed.
