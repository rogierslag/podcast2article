# Share to Reads from Android

1. Open Reads in Chrome on Android and sign in.
2. Expand **Add from Android** and choose **Install Reads** when Chrome offers
   the button. Otherwise use Chrome's menu: **Add to Home screen → Install**.
   Install the web app; a plain URL shortcut does not register a share target.
3. In Spotify, share an episode and choose **Reads**, possibly under **More**.
4. Reads opens with the link filled in. Sign in if needed, review the settings,
   and choose **Create article**.

Chrome controls when its installation prompt becomes available. HTTPS is required
in production. Other Android browsers may behave differently; the instructions
use Chrome as the supported installation path. The iOS Shortcut stays separate.

## Implementation

The public web manifest and 192/512-pixel icons describe the installable app.
Icons use the full brand mark; the tiny browser favicon uses its simplified
variant. Rebuild both with `node scripts/build-brand-assets.mjs`. The manifest registers a GET
share target at `/share-target`, which extracts a single HTTP(S) URL from the URL,
text, or title field and redirects to the existing form-prefill route. Android
commonly sends a URL as text. Ambiguous multi-link text is ignored. Values remain
untrusted form data and source validation still runs when the user submits.

The share route does not read accounts, create jobs, or change stored data.
Authentication still protects the form, collections, and jobs. The route never
redirects to a shared external URL. No service worker, offline cache, or private
content caching is added. Current Chrome installation criteria do not require a
service worker; this flow requires a network connection.

The Android-only setup UI uses browser-controlled `beforeinstallprompt` and
`appinstalled` events, with menu instructions as a fallback. Standalone app windows
hide installation help. The event API is not available in every browser.

## Verification before release

Browser tests cover the incoming text route through login, public manifest/icon
responses, and a simulated installation event lifecycle. These do not prove OS
registration or installation. On a physical Android device, install from the
production HTTPS origin using Chrome, verify Reads appears in Spotify's share
sheet, and share with and without an active login. Check that generation only
starts after explicit submission. Also verify opening Reads from its home-screen
icon and its standalone navigation.

References:

- [Chrome Web Share Target](https://developer.chrome.com/docs/capabilities/web-apis/web-share-target)
- [Chrome installation criteria](https://web.dev/articles/install-criteria)
