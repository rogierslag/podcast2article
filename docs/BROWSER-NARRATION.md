# Browser narration

When enabled, completed owner articles offer one **Listen** text action beside the reading time.
The same button pauses playback; saved progress resumes when the reader presses Continue.
The player reads the title, introduction, section headings, paragraphs, quotes, and takeaways in order.
It excludes citation controls, transcript text, reading-time estimates, and editorial style metadata.
No OpenAI speech request, generated audio file, or additional paid narration service is used.

## Feature flag

Narration is disabled by default.
Set `BROWSER_NARRATION_ENABLED=true` to enable it, with an optional comma-separated `BROWSER_NARRATION_USERS` account allowlist for an initial trial.
An empty allowlist enables all accounts; use `local` for development without authentication.
For example, enable the flag and set `BROWSER_NARRATION_USERS=rogier` to try it only on that account.
Restart the server after changing either setting.
Set `BROWSER_NARRATION_ENABLED=false` to disable the feature for everyone, including listed accounts.
Existing open pages need reloading to remove their client-side controls; subsequent progress writes are rejected immediately by the restarted server.
Saved positions are retained for later re-enablement.

The server selects availability per authenticated account in uncached owner HTML.
Disabled accounts see no player, and the progress endpoint returns `404` without changing the stored position.
The authenticated voice-demo page is gated by the same flag; the standalone development demo server is separate.
No flag or owner listening state is exposed on public shared pages.

## Voices and controls

Open the **⋯** menu to select the text language, a browser voice, or playback speed.
The default language follows the article's requested language; articles requested with automatic language selection use the interface language until the reader selects the appropriate language.
Available voices are filtered by that language and local voices are listed first.
For English, Daniel is preferred among local voices when available.
The browser remembers voice preferences per language and playback speed on that device; a missing preferred voice falls back to an available voice.
Selecting a voice or speed pauses playback so the next explicit continuation uses the new choice.

Local voices run on the device.
Remote voices may send the written text to the browser's speech provider.
Only voices exposed by the browser can be selected, even if other voices are installed on the operating system.
If no voice is available, select the article's language in the menu; the text remains readable.
The voice list updates when the browser reports new voices or the menu is opened.
The menu also contains **From the beginning**; there are no passage-skip controls or repeated passage text.

## Progress and interruption

The reader splits the article deterministically into short passages and shows the completed percentage in the Listen/Pause control after listening starts.
This is passage progress, not an audio timestamp or evidence of comprehension.
Pause cancels the current utterance; **Continue** repeats that passage.
The player pauses when the document becomes hidden, when the reader leaves the article, and when source playback is requested.
It never resumes automatically after returning to the page or closing source playback.
Browser events and OS suspension can still interrupt speech before the page receives a notification.
The most recently persisted passage remains the recovery point.

Each completed passage and explicit restart queues an authenticated save through the existing job persistence helper.
The account position is available on other devices after the save succeeds; each device retains its own voice preferences.
A failed save is shown beside a **Retry saving** action, and reconnecting retries the current position while the article remains open.
No offline position is stored in browser storage; closing before a successful save may repeat passages on return.
Writes from one player are serialized; across simultaneously active devices, the last accepted save wins.
Completing narration does not change the article's explicit read status.

## API and storage

`PATCH /api/jobs/:id/listening-position` accepts `{ "version": 1, "passageIndex": 0 }` and returns `{ "listeningPosition": { "version": 1, "passageIndex": 0, "updatedAt": "..." } }`.
The index must be an integer from zero through the number of passages, inclusive; the final index represents completion.
The endpoint requires the owning account and a completed, non-deleted article.
Invalid shapes return `400`, unavailable articles return `404`, and invalid article-relative positions or non-completed articles return `409`.
The stored `Job.listeningPosition` is independent of `readingPosition` and `readAt`.
Legacy jobs without this field begin at the first passage; invalid saved positions are discarded on load.
Public share payloads omit listening state, and saving a shared article never copies the original owner's position.

The segmentation algorithm in `public/article-speech-text.js` is versioned with the position and must remain deterministic across server and browser.
Changing version-1 segmentation requires a migration or a new position version.

## Verification

Unit and server tests cover text selection, bounded passages, persisted positions, validation, account isolation, and public payloads.
Browser tests simulate speech events to cover interruption, explicit resume, preferences, failed saves, source playback, navigation, and layout.
They cannot validate the sound of installed voices or real iOS suspension.
The [voice demo](VOICE-DEMO.md) remains available for physical-device comparisons.
