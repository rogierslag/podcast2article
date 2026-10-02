# Browser voice demo

Open `/voice-demo.html` on the running application to compare browser speech on different devices.
Enable the [browser narration feature flag](BROWSER-NARRATION.md#feature-flag) for the account first.
The demo uses the existing authentication boundary and does not call a paid speech API or modify articles.
Its interface follows the browser language (Dutch or English); text language is selected separately.

Choose a text language, load its sample, choose a voice, and select **Preview voice** or **Listen / continue**.
Voice names include whether the browser reports them as local or remote.
Remote voices may send text to the browser's speech provider.
Only voices exposed by the current browser are available; downloaded system voices are not guaranteed to appear.

The demo stores text, voice preference, speed, and passage position in this browser's local storage.
It does not sync across devices or accounts, so avoid sensitive text on a shared browser.
Changing text resets progress; changing voice or speed stops speech and retains the current passage.
Pause cancels speech and Continue repeats the current bounded passage, avoiding dependence on native pause/resume behavior.
Progress counts completed passages rather than elapsed audio time.

## Device test

1. Preview several Dutch and English voices and compare pronunciation and listening comfort.
2. Load the long test, which repeats the sample ten times, and listen through passage transitions.
3. Pause, continue, skip passages, and reload to verify saved progress.
4. On an iPhone, lock the screen for 30 seconds and switch apps while listening, then return and try continuing.
5. Open **Device and playback log** and copy the result to compare voice selection, request-to-start latency, visibility changes, and errors.

Browser compatibility is not proof of working background playback.
Automated tests use simulated speech events to verify controls and persistence; real voice quality, audible gaps, and iOS screen-lock behavior require physical-device testing.

## Access from another device

An iPhone cannot access the Mac's `127.0.0.1` address.
For an isolated local demo, run `node scripts/voice-demo-server.mjs`, then `ngrok http 4317` and open the returned HTTPS URL on each device.
The dedicated server binds to `127.0.0.1:4317` and serves only the four demo assets; all other paths return `404`.
Keep both processes running during device testing and stop them when finished.
Use the demo path on a deployed application, or serve only the four demo files (`voice-demo.html`, `voice-demo.js`, `voice-demo.css`, and `theme.css`) from a trusted development host reachable by both devices.
Do not expose the application or user data to the network merely to share this demo.
Clipboard access may be unavailable over plain HTTP; the displayed log can still be selected manually.
