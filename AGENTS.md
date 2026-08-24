# AGENTS.md

This file applies to the entire repository.

## Product and language

- Podcast2Article turns public Spotify episodes, YouTube videos, and Google Drive recordings into source-linked articles.
- User-facing copy is Dutch unless the surrounding UI explicitly uses another language.
- Preserve the editorial visual style in `public/styles.css`: warm paper colors, serif article typography, compact monospace metadata, and restrained controls.
- Keep accessibility intact: semantic elements, useful `aria-label` values, keyboard focus styles, and sufficient contrast.

## UI changes and screenshots

- For every material UI change, render the real local application in a browser and visually verify it. Do not rely only on HTML/CSS inspection.
- Check both a normal desktop viewport and the relevant mobile breakpoint. The primary mobile reference is approximately `390x844`; the primary desktop reference is approximately `1440x1000`.
- Capture screenshots of the states affected by the change and include them in the final handoff. Store generated screenshots outside the tracked source tree when possible.
- Include those screenshots in the pull request description for every material visual change. Show before and after images when the change modifies existing UI; an after-only image is sufficient for a genuinely new screen or state.
- Record and attach a short video or animated capture when motion or interaction is important and screenshots would be ambiguous—for example responsive transitions, loading/progress behavior, audio seeking, menus, multi-step flows, focus behavior, or state changes after clicking an action.
- Keep PR media focused and reviewable: use the smallest number of screenshots or clips that proves the affected desktop and mobile states, label each viewport/state, and avoid unrelated application or desktop content.
- Do not commit large screenshot or video artifacts to the repository unless the project explicitly requests it. Prefer PR-hosted attachments or another approved artifact location, and link them from the PR description.
- Use realistic sample content so typography, wrapping, metadata, images, and long-form article layout are representative.
- If a temporary stored job or media fixture is required for screenshots, create it under a clearly test-only ID and remove it after capture. Never alter or delete a user's existing article data.
- Inspect the rendered DOM or accessibility tree as well as the screenshot when verifying labels and responsive visibility.
- For local browser testing, start the compiled server from the repository root so `public/` and `data/` resolve correctly. Stop the temporary server when finished.
- Use the fixed local browser-testing URL `http://127.0.0.1:4317` (`PORT=4317 HOST=127.0.0.1`) so Codex can reuse the same browser permission. Before starting a server, check whether that port already serves this application and reuse it when appropriate; never stop a server that Codex did not start for the current task.

## Current article-action behavior

- Article pages expose three owner actions: `Markeer als gelezen`, PDF export, and permalink copy.
- On mobile, keep `Markeer als gelezen` written out. PDF and permalink actions should use recognizable printer and share icons with accessible labels; their visible text may collapse at the mobile breakpoint.
- Keep the same actions available at the top of the article and in the completion footer unless the task explicitly changes that behavior.

## Permalink security invariants

- Public permalinks are capability URLs backed by a stable, high-entropy token. Do not replace them with a sequential identifier, username, article index, or bare job UUID.
- A public token may resolve only its own completed article and its own source audio. It must not grant access to `/api/articles`, `/api/jobs`, reading state, account identity, another article, or owner-only mutations.
- Public API responses must be explicitly shaped. Do not serialize an entire stored `Job` object.
- Shared pages are anonymous: do not expose the username, account details, sender identity, internal job ID, share token in the payload, or read state.
- Keep public routes narrowly registered before the authentication middleware. All owner and collection routes remain authenticated when authentication is enabled.
- Shared pages need server-rendered Open Graph and Twitter metadata because link-preview crawlers do not execute the client application. Escape all metadata values.
- Use `PUBLIC_BASE_URL` for canonical production permalink and Open Graph URLs when configured; fall back to the request origin for local development.
- Keep shared capability pages out of search indexes with `noindex, nofollow` unless the product requirements explicitly change.

## Project structure

- `src/server.ts`: Express routes, authentication boundary, public share surface, and server startup.
- `src/services/jobs.ts`: job persistence, per-user isolation, processing queue, read state, and share-token lookup.
- `src/services/pdf.ts`: server-side PDF generation.
- `src/types.ts`: persisted and API-related domain types.
- `public/index.html` and `public/app.js`: authenticated/owner application UI.
- `public/share.html`, `public/share.js`, and `public/share.css`: anonymous public article reader.
- `public/styles.css`: shared and owner styling. This file is intentionally compact; make scoped additions and avoid unrelated reformatting.
- `data/users/<username>/`: runtime data. Treat it as user-owned and do not commit it.

## Implementation guidelines

- Preserve per-user storage isolation. Validate usernames and UUID-shaped job IDs before constructing storage paths.
- Persist tokens and job mutations through the existing job persistence helpers so links survive restarts.
- Repeated permalink creation must return the same link for the same article rather than silently creating multiple URLs.
- Use `crypto.randomBytes` or an equivalently cryptographically secure generator for capability tokens.
- Keep public payloads minimal. For source buttons, expose only the fields the reader needs, such as transcript source ID and start time—not the full private transcript unless explicitly required.
- Escape untrusted content before inserting it into HTML. Continue using the existing client-side `escapeHtml` pattern and server-side metadata escaping.
- Avoid adding a framework or build step for the static frontend unless the task requires it.
- Keep changes focused and preserve unrelated user modifications in a dirty worktree.

## Validation

Run the full check before handing off implementation changes:

```sh
npm run check
```

For frontend JavaScript changes, also run:

```sh
node --check public/app.js
node --check public/share.js
```

Also run:

```sh
git diff --check
```

For authentication or permalink work, smoke-test at least these runtime boundaries with authentication enabled:

- An invalid public share token returns a public `404` rather than a login redirect.
- Public share assets load without authentication.
- `/api/articles` and `/api/jobs` still return `401` without a valid session.
- A valid token returns only the intended article payload.
- An unrelated or malformed token cannot fetch article data or audio.

Report the checks performed and any checks that could not be run. Do not claim visual verification unless the rendered browser state was actually inspected.

In the pull request description, include a concise verification section with:

- The commands and runtime checks performed.
- Desktop and mobile screenshots for material UI changes.
- A short recording when behavior, motion, or a multi-step interaction is part of the change.
- Any known visual or testing limitations.

## Pull requests

- Pull request titles, descriptions, section headings, image/video captions, and reviewer-facing notes must always be written in English, even when the user request or product UI is in Dutch.
- When the user indicates that a pull request should be created, carry the task through to an actual PR: prepare the branch and commits as needed, push the branch, create the PR, and return the PR link. Do not stop after drafting a title or description unless an external blocker or missing authorization prevents creation.
- Prefer the local `gh` CLI and documented GitHub APIs for PR operations. Do not open GitHub in a browser solely to create or edit a PR or to work around a missing API capability.
- Before starting PR operations, run `gh auth status`. If the worktree is on a detached `HEAD`, create a focused branch before committing. Preserve unrelated worktree changes and stage only the files intended for the PR.
- Before creating the PR, run the required validation and produce the applicable screenshots or recordings described above.
- Write the PR description to a temporary Markdown file and pass it with `gh pr create --body-file` or `gh pr edit --body-file`. Do not pass multiline Markdown inline through the shell because backticks and substitutions may be interpreted as commands.
- Add the screenshots and videos to the PR description itself, or use durable links/attachments that reviewers can open from the PR. Do not leave required visual evidence only in a local filesystem path.
- GitHub's documented APIs and `gh` CLI do not upload native PR-body attachments. Use an approved durable artifact location when available. If none is configured, create a dedicated `pr-assets-<PR number>` branch through `gh api`, keep binary media out of the feature branch and PR diff, and embed its raw GitHub URLs in the PR description. State this storage choice in the PR notes and keep the asset branch available so its links remain valid.
- If no durable upload is possible, report the limitation clearly in the PR, include all remaining evidence, and provide the exact local artifact paths so the user can attach them; do not silently omit required media.
- PR titles and descriptions must be concise but complete. Remove repetition and implementation diary details, but never omit behavior changes, security implications, migrations/configuration, verification performed, visual evidence, known limitations, or reviewer-relevant tradeoffs.
- Prefer this compact PR-description structure when applicable:
  - **Summary:** what changed and why.
  - **Security/behavior:** access boundaries, persistence, compatibility, or other important implications.
  - **Visuals:** labelled desktop/mobile screenshots and short recordings where interaction matters.
  - **Verification:** commands and focused runtime checks performed.
  - **Notes:** configuration, migrations, limitations, or follow-up work; omit this section when empty.
- Ensure the final PR description reflects the actual diff and completed checks. Do not claim an attachment, test, screenshot, or recording that was not successfully produced and made available to reviewers.
- After every PR creation or description update, use `gh pr view --json` to verify the remote title, body, head branch, state, verification claims, and media URLs before handing off.
