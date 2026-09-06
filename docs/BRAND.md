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
  progress clearly, and avoid competing demands for attention.
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

Preserve that character when adding features. A new action should fit the
existing reading experience without requiring another boxed panel, accent color,
or decorative effect. Source references should make an article easier to verify
without interrupting the reader's place.

## Typography and layout

- Use Newsreader for editorial headings and article typography, Manrope for
  interface text, and DM Mono for compact metadata and utility labels. Reuse the
  existing `--serif`, `--sans`, and `--mono` properties.
- Keep long text comfortable to read through line length, line height, and space
  between sections. Preserve the distinction between headlines, introductions,
  body text, and metadata.
- Use alignment, whitespace, and thin rules to group content. Article lists keep
  their editorial layout rather than becoming a collection of rounded cards.
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
| Circular brand marks, audio controls, and waveform details          | Existing functional shape | Preserve circles and rounded strokes where they express the mark or playback function.                    |
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

Dutch is the default user-facing language. Where the interface offers English,
preserve the same meaning and tone across translations. Keep source attribution
clear and respect the anonymous nature of public article pages.

## Applying the guide

For a design or copy change, identify the intended impression and the component's
role before choosing its wording, shape,
type, or color. Reuse existing styles and semantic properties, and update this
guide when a deliberate design decision changes the rules.

Verify the real application on desktop and mobile, including affected light,
dark, focus, print, and reduced-motion states. Follow the screenshot and recording
requirements in [AGENTS.md](../AGENTS.md). Review whether the change preserves
reading comfort, source access, and the distinction between content and controls.
