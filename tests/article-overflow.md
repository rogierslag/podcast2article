# Article overflow regression

Run these checks in the real application, in both the owner article reader and
the anonymous shared reader. Use a temporary completed article; do not modify
existing user articles.

## Test content

- Title: `Waarom deze CPO spijt heeft dat productmanagement bestaat`
- Repeat with a title containing an unbroken string of 100 characters, to test
  wrapping when the browser has no matching hyphenation dictionary.
- Include a long compound word and a long URL in the article body.
- Use an episode title such as `De rol van productteams` with artwork, and check
  that the episode header's text column can shrink at 320px without overflowing.

## Viewports and assertions

Check at 320 × 740, 390 × 844, 800 × 1000, and 1440 × 1000, including Safari on
iOS when available.

1. The full title remains readable within the article column. Long words may
   hyphenate or wrap; no text is clipped or replaced with an ellipsis.
2. Normal-length words retain their normal wrapping and the editorial type size
   remains unchanged.
3. Long body text and URLs wrap within the article column.
4. Neither the document nor `.page-scroll` has horizontal overflow. Inspect
   `scrollWidth` and `clientWidth` for each scroll container and confirm they are
   equal. Attempting to scroll sideways must not shift the article.
5. The owner reader's top and bottom actions remain keyboard accessible. On
   mobile, `Markeer als gelezen` is written out, while PDF and share controls have
   visible icons and accessible names.
6. Capture desktop and mobile screenshots. Repeat the narrow-width check with
   enlarged text, and inspect print preview for wrapped, unclipped headings.

Do not satisfy these assertions by adding horizontal overflow clipping or a
horizontal scroll container: all article text must remain available.
