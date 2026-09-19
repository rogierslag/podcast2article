# Podcast2Article brand identity

Podcast2Article turns recordings into articles that people can read comfortably
and check against the source. The interface should make that purpose visible:
give the article room, keep its references close, and make the next action clear.

This guide defines the intended brand experience for the owner application, public reader,
login, and supporting dialogs. It guides future changes; it is not a claim that
every existing component already follows every rule. Use [AGENTS.md](../AGENTS.md)
for implementation, accessibility, and visual verification requirements.

## Intended impression

Podcast2Article should feel like a thoughtful publication with useful tools close
at hand. The reader should feel welcome, able to settle into an article, and free
to check what the original recording actually said. This is the intended
impression, not a measured claim about how every reader experiences the app.

- **Calm:** give reading time and space. Keep secondary actions quiet, show
  progress clearly, and give each screen a clear focal point. Expressive type
  and graphics can support that hierarchy when they share one visual language.
- **Thoughtful and editorial:** treat hierarchy, typography, source attribution,
  and small interaction details as part of the quality of the article experience.
- **Warm and approachable:** use familiar language, comfortable spacing, warm
  surfaces, and subtly softened controls. The interface should be easy to enter
  without feeling casual about the content.
- **Trustworthy and transparent:** make sources easy to inspect and state errors
  or limitations plainly. A polished article must not imply that its generated
  claims are guaranteed to be accurate.
- **Capable and restrained:** make useful actions easy to find and predictable to
  use. Let the experience demonstrate care without promotional language or
  decorative complexity.

These qualities guide both appearance and behavior. A rounded button can support
approachability; a clear label and reliable action must support it too. Source
access, readable text, and respectful interactions carry the brand as much as
the palette does.

## Visual expression

The app has an editorial character: warm paper surfaces, expressive serif
headings, readable article text, compact metadata, and fine dividing lines.
Spacing and typography establish hierarchy. Controls remain restrained so the
content holds attention.

The recording-to-article transition is the central graphic idea. Its irregular
rhythm and curved strokes bring character to the identity. Give that idea room
on the landing page, where it explains the product, and use it compactly for
identification in the header and login. Article pages give the reading itself
the most space. This difference in emphasis keeps the identity expressive
without making every screen equally busy.

Preserve that character when adding features. A new action should fit the
existing reading experience without requiring another boxed panel, accent color,
or decorative effect. Source references should make an article easier to verify
without interrupting the reader's place.

### Brand mark

Use one mark throughout the application. Four vertical strokes form an uneven
waveform; three following strokes curve continuously into horizontal text lines.
The waveform uses green, the outer text strokes use ink, and the middle curved
stroke uses orange. That orange stroke marks the transition from sound to text.

- Reuse the same contours, proportions, line weights, rounded ends, and color
  roles in the owner header, public reader header, login, and landing illustration.
  Scale the complete artwork rather than drawing a different mark for each role.
- Use that same static mark on the processing screen. Let the episode title,
  stage, and actual progress explain what is happening; a spinning record adds
  a competing audio metaphor without useful progress information.
- Preserve the uneven waveform heights and staggered line lengths. The curved
  strokes must visibly become text lines; keep the transition continuous.
- Keep the mark open, without a surrounding badge, divider, or extra icon.
  Keep literal words out of the artwork so it works across interface languages.
- Keep the landing kicker text-only. The header identifies the product and the
  larger landing illustration explains the transformation; a third illustrated
  version above the headline adds no distinct role.
- Retain a compact landing illustration on mobile. Adjust its placement and
  surrounding spacing so the headline, introduction, and source input remain
  easy to reach. Check that the curved strokes stay distinct at the smallest size.
- Keep the mark static. Its shape should communicate the transformation without
  requiring animation.

### Favicons and app icons

Use the same identity in browser tabs and installed-app icons. Place the artwork
on a cream square tile with enough space to survive the platform's corner shape
or mask. Keep the mark's green, ink, and orange roles; do not add a black disc or
an orange surround.

Installed-app icons use the complete four-waveform, three-curve mark. The tiny
favicon is an optical size variant: use two green waveform strokes, an orange
curved stroke, and a short ink curve into a text line. It must still show sound
becoming text. Check the favicon at its actual 16px and 32px display sizes, where
the full artwork's details would merge. Keep this simplification confined to
small icons; it does not replace the full mark elsewhere.

### Social previews

The site's social preview uses a 1200 × 630 composition with the shared mark,
editorial typography, and the light paper palette. Keep the product name and
short headline readable when reduced to a feed thumbnail. Provide Dutch and
English versions with the same composition and meaning. Leave room around the
content so minor preview crops do not cut into the identity.

Article previews should retain the recording's source image when one is
available. Use the generic product card as a fallback for articles without an
image. Keep the article's own title and description in its preview metadata in
both cases; the fallback artwork identifies the product without inventing an
illustration of the recording. Shared previews remain anonymous.

Run `node scripts/build-brand-assets.mjs` to regenerate the checked-in SVG, PNG,
and ICO assets. The script uses the owner header's master mark, the light theme
tokens, and the translated hero copy. It requires the project's Playwright
Chromium installation and access to Google Fonts; production builds serve the
generated files without either dependency. Review the images after regeneration.

Preview metadata is rendered on the server with absolute public image URLs,
descriptive image alternatives, and dimensions for the generated cards, following
the [Open Graph image properties](https://ogp.me/#structured). Use
`PUBLIC_BASE_URL` for the production origin. Public image access must not expose
account data or owner-only routes.

## Typography and layout

- Use Newsreader for editorial headings and article typography, Manrope for
  interface text, and DM Mono for compact metadata and utility labels. Reuse the
  existing `--serif`, `--sans`, and `--mono` properties.
- The login screen uses Georgia and system interface fonts so signing in does
  not depend on external font loading. Its shared mark, paper palette, and
  heading hierarchy maintain the connection to the reader.
- Keep long text comfortable to read through line length, line height, and space
  between sections. Preserve the distinction between headlines, introductions,
  body text, and metadata.
- Use alignment, whitespace, and thin rules to group content. Article lists keep
  their editorial layout rather than becoming a collection of rounded cards.
- On the landing page, let the headline lead, the illustration explain the
  transformation, and the introduction lead into the source input. Balance these
  elements as one composition; avoid enlarging each independently until they
  compete. Keep the source input close enough to make the next action clear.
- Keep images rectangular and aligned with the surrounding content. Let the
  source imagery supply variety without adding decorative frames.
- On smaller screens, adapt spacing and arrangement while preserving hierarchy,
  readable labels, and usable controls. Compact metadata must still be legible.

## Color and surfaces

Use the semantic properties in [theme.css](../public/theme.css) for color values.
The light theme uses cream for the page, lighter paper for surfaces, dark ink for
text, orange for emphasis, and green for supporting accents. Accent colors should
retain a clear purpose rather than spreading across every component. Use `--accent-text`
for smaller orange text and links; reserve `--orange` for decoration, accent surfaces,
and large editorial headings. Control boundaries use `--control-border` so they
remain distinguishable while structural rules retain the quieter `--line`.

The dark theme preserves the same warmth and hierarchy with dark neutral surfaces
and adjusted foregrounds. Choose surface and text roles separately: an inverse
surface and a text color are not interchangeable. Keep the light palette for
print and verify contrast in both screen themes.

Borders should remain fine and quiet. Use shadows sparingly to establish depth,
such as the composer and a dialog above the page. Avoid adding shadows to every
article or control.

## Corners

Corner shape follows the element's role. Small radii soften interaction surfaces
while straight edges preserve the structure of the editorial page.

| Element                                                             | Intended radius           | Application                                                                                               |
| ------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| Bounded buttons, selects, and input fields                          | 3px                       | Apply consistently to standalone controls, including language controls and dialog buttons.                |
| Floating modals and dialogs                                         | 4px                       | Keep the current source-preview treatment, with paper background, a thin border, and a restrained shadow. |
| Composer, article layout, article images, and structural containers | 0                         | Preserve the page's straight edges and alignment.                                                         |
| Audio controls, icon tiles, and waveform details                    | Existing functional shape | Preserve rounded waveform strokes, playback controls, and icon shapes required by their platform.         |
| Native media controls                                               | Browser-defined           | Preserve native behavior and accessibility.                                                               |

Text links, underlined input rows, and dividing lines do not need rounded corners.
For joined controls, round only the outside corners so the group remains visually
connected. Avoid pill-shaped utility buttons and broad rounding across panels.

Bounded controls use the shared `--control-radius: 3px` property across the owner,
public reader, and login screens, including source references and language buttons.
The source-preview dialog uses `--dialog-radius: 4px`. Keep radius declarations
scoped to these components so article containers, images, and structural elements
retain their straight edges.

## Interactions and motion

Actions should have clear labels and predictable results. Preserve the article
actions and mobile labels described in [AGENTS.md](../AGENTS.md). Icons may save
space where their meaning is recognizable, but they still need accessible names.

Button interaction styles are shared in `theme.css`. Primary actions use an orange
hover and pressed state; secondary buttons use an inverse surface, source references
use green, and text actions change text color. Use the same 3px focus ring for keyboard
navigation. Disabled buttons do not respond to hover or press. Color transitions take
150ms and are disabled when reduced motion is requested; hover feedback applies only
on devices that support hover.

Use motion to explain a state change or maintain orientation. Keep it brief and
subtle; avoid decorative movement around reading content. Respect reduced-motion
preferences. The source-preview dialog's current 150ms entrance and 100ms exit
fades provide a reference for a restrained transition, not a duration requirement
for every interaction.

Dialogs are temporary reading aids. Keep their heading, close action, and relevant
content easy to find. Preserve Escape dismissal, keyboard focus handling, the
reader's position, and audio stopping when the preview closes. A softer corner
must never come at the cost of a visible focus outline or usable hit area.

## Product voice

Use direct, concrete language that explains what an action does or what happened.
Keep labels short enough to scan without making their meaning ambiguous. Errors
should explain the problem and the available next step. Avoid promotional claims
and unnecessary technical details in the reading flow.

Keep processing failures beside the source title and recovery actions. Distinguish
checking an unavailable status from starting paid work. Explain when an existing
transcript can be reused and when regenerating the article incurs additional cost.
Returning to the source form should preserve its link, language, and length.

Dutch is the default user-facing language. Where the interface offers English,
preserve the same meaning and tone across translations. Keep source attribution
clear and respect the anonymous nature of public article pages.

## Applying the guide

For a design or copy change, identify the intended impression and the component's
role before choosing its wording, shape,
type, or color. Reuse existing styles and semantic properties, and update this
guide when a deliberate design decision changes the rules.

Check the identity across surfaces as well as within a single screen. The mark
should remain recognizable at header and illustration sizes, while the
headline, source input, and article retain their intended priority. Additional
graphic variants need a distinct role that the existing artwork cannot serve.

Verify the real application on desktop and mobile, including affected light,
dark, focus, print, and reduced-motion states. Follow the screenshot and recording
requirements in [AGENTS.md](../AGENTS.md). Review whether the change preserves
reading comfort, source access, and the distinction between content and controls.
