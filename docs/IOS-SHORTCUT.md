# Add to Reads on iOS

The bundled **Add to Reads** Shortcut receives URLs or text from the share
sheet, extracts the first URL, URL-encodes it, and opens
`https://reads.rogierslag.nl/?sourceUrl=<encoded URL>` in the default browser.
It does not submit a job, store credentials, or read the clipboard. Use it from
the share sheet with a link; source validation still happens on explicit
submission in Reads.

## Installation

Open Reads on your iPhone or iPad, expand **Add from your iPhone or iPad** below the form,
and choose **Download Add to Reads**. Open the downloaded `.shortcut` file
in Apple's Shortcuts app and choose **Add Shortcut**. Depending on Safari's
download behaviour, open it from Downloads or Files first.

The download and installation help appear only on detected iOS/iPadOS devices,
including iPads requesting desktop websites. They stay hidden on desktop and
Android. Device detection controls UI visibility; the authenticated download
route is unchanged and does not treat browser identification as authorization.

In Spotify, share an **episode**, choose **More** to open the system share sheet,
and scroll to **Add to Reads**. Reads opens with the link filled in. Sign in if
needed, review language and article length, then explicitly create the article.
Other supported source links can use the same flow. Sharing a Spotify show or
track does not make it a supported episode.

## Rebuilding the installer

The signed file is a small product asset committed in
`public/shortcuts/Add to Reads.shortcut`. The readable builder is
`scripts/shortcuts/build.py`; it requires Python 3. Signing requires macOS,
Apple's Shortcuts app, and network access. Signing in `anyone` mode sends the
workflow to Apple for validation and avoids the contacts-only distribution mode.

```sh
python3 scripts/shortcuts/build.py --output /tmp/add-to-reads-unsigned.shortcut
shortcuts sign --mode anyone \
  --input /tmp/add-to-reads-unsigned.shortcut \
  --output 'public/shortcuts/Add to Reads.shortcut'
```

For a different deployment, pass `--origin https://your-reads-domain.example`
to the builder and re-sign. The bundled Shortcut deliberately targets the
production origin from `deploy/Caddyfile`; it does not infer a destination from
an untrusted shared link. No server configuration or database migration is needed.

## Verification before release

- Run `npm run check` and the `scripts/browser/shortcut.browser.mjs` tests.
- Import the signed file and inspect all five action inputs, including the
  encoded URL variable. A successful signature alone does not prove the actions
  are wired correctly.
- On a physical iPhone, install through Safari and share a Spotify episode.
  Verify the URL query survives, login preserves it, and no article starts until
  the user confirms. Test both an existing session and a signed-out browser.
- Confirm the share-sheet action is visible and the first-use permission prompts
  are understandable. Desktop WebKit is not a substitute for this device check.

An iCloud share link could shorten installation later. The current flow serves
the signed file directly and does not depend on an unpublished iCloud URL.
