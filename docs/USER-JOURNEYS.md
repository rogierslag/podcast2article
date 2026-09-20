# User journeys and feature value

Podcast2Article helps someone turn a public recording into an article they can read, return to, and check against the original.
A feature earns its place when it removes a concrete obstacle in that sequence without weakening source accuracy, privacy, accessibility, or control over paid processing.

Use this document with [BRAND.md](BRAND.md) when proposing or reviewing features.
The journeys describe needs and observable outcomes; the brand guide describes how the interface should express them.

## Evidence and limits

This is the 19 September 2026 review, after rebasing onto `main` at `0239d8e`.
PR preparation also validated the branch on `c091ba6` with the Node 24 tooling update.
The shared-permalink monitoring follow-up adds the event definitions below; the original review is historical context, not evidence of deployed instrumentation.
“Implemented” means present in the reviewed code, not verified deployed.
Linked pull requests explain decisions and previous verification; their test results are not a substitute for checking the combined application.

- **Stated user intent:** the earlier task “Codex podcast transcriptie” asked for public Spotify links to become text based only on the recording, with minimal input and an open-source solution.
  This review adds the explicit preference for one coherent sound-to-text identity.
  These are product-owner requests, not findings from a representative user study.
- **Implemented behavior:** grounded in the current [README](../README.md), [server routes](../src/server.ts), [job storage](../src/services/jobs.ts), [owner reader](../public/app.js), [public reader](../public/share.js), and [series implementation](../src/services/subscriptions.ts).
- **Value hypotheses:** easier capture, less repeated work, better reading continuity, and a manageable backlog are plausible reasons for the features below.
  No usage baseline, conversion lift, time saved, or satisfaction result was supplied or measured for this document.

## Journey map

With authentication enabled, account holders manage their own library and processing requests.
A permalink recipient can read anonymously or save a copy when signed in.
The installation operator configures accounts and the API key; the interface does not provide self-service account creation or per-reader billing.

| Job                           | Trigger                                                                         | Desired outcome                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| J1. Capture a recording       | I find a recording in Spotify, YouTube, Fathom, or Drive.                       | The right link reaches the form, and I understand whether it can be processed.      |
| J2. Choose a readable version | I want the content in a particular language or level of detail.                 | I know what I am requesting and can reuse an existing matching article.             |
| J3. Wait and recover          | Processing takes time, fails, or is interrupted.                                | I can leave, find the result later, and recover without unnecessarily paying again. |
| J4. Read and return           | I have an unread article or resume after an interruption.                       | I can select, understand, continue, and finish it without losing my place.          |
| J5. Check a source            | A claim, quote, or speaker attribution needs checking.                          | I reach the relevant passage and return to the same reading context.                |
| J6. Share or keep a copy      | I want another person to read the article, or want to keep one someone sent me. | The recipient can read safely, and a personal copy or PDF behaves as expected.      |
| J7. Follow a series           | I want future episodes without repeatedly pasting links.                        | Useful articles arrive while I retain control of catch-up, cost, and unread work.   |

These jobs form loops: checking a source returns to reading, finishing returns to the library, and following a series creates another reading backlog.
A screen can serve more than one job; a feature should still name its primary outcome.

## J1. Capture a public recording

The compact login page offers a public example article before sign-in.
The link opens in a new tab so visitors can inspect the result and its source references without losing their login form or prefilled recording link.
It uses an existing English article; interface labels remain Dutch or English.
Viewing the example does not start processing.
The featured article must remain available for its permalink to work.
This implements the approved login-link scope of [issue 70](https://github.com/rogierslag/podcast2article/issues/70); it does not add an excerpt or example to the unauthenticated-mode home page.

**Implemented.**
The form accepts supported public episode/video/recording links.
A Spotify show link leads to series setup.
The iOS Shortcut and Android share target prefill the form and preserve the link through login; neither creates an article without explicit submission.
Public access and source matching are validated by the server.
See [PR 27](https://github.com/rogierslag/podcast2article/pull/27), [PR 50](https://github.com/rogierslag/podcast2article/pull/50), [iOS sharing](IOS-SHORTCUT.md), and [Android sharing](ANDROID-SHARING.md).

**Critical states and trust.**
Signed-out and expired sessions must preserve the intended source.
Private recordings, Spotify exclusives, missing public audio, unsupported links, and ambiguous input must produce useful errors rather than selecting another recording.
Metadata and missing artwork must remain readable.
An incoming share must never become an external redirect or a paid submission.

**Value test.**
Start in the source app, share a supported recording while signed out, sign in, and identify the prefilled source and next action without help.
Repeat with an unsupported source.
Native installation and share-sheet behavior still require physical-phone checks; browser tests alone do not establish them.

## J2. Choose language and article length

**Implemented.**
Interface language and generated-article language are separate.
Source-language detection is distinct from an explicit language choice.
Compact, standard, and extended show target word ranges, with a guideline disclaimer.
Duplicate detection matches source, language setting, and length within the same account; it links to the existing article or active job.
Other variants remain possible.
See [PR 17](https://github.com/rogierslag/podcast2article/pull/17) and [PR 35](https://github.com/rogierslag/podcast2article/pull/35).

**Critical states and trust.**
A duplicate warning should recover previous work, not feel like a dead end.
Changing the interface language must not imply that existing content has been translated.
Word ranges and reading time are estimates, not guarantees.
Failed and deleted jobs do not block a new submission.

**Value test.**
Ask a reader to choose a brief article in a different language, explain what will change, then submit a matching duplicate and open the existing result.
Judge whether the resulting article preserves the recording's meaning; meeting a word count alone does not establish usefulness.

## J3. Process, leave, and recover

**Implemented.**
A job shows its processing stage and progress.
Active jobs also appear in the library, with source metadata loaded separately.
Up to three jobs process concurrently while media preparation stays serial.
Usage attempts and known cost estimates are stored per job.
Article generation starts with Flex and falls back to standard processing after three transient failures, with at most three further attempts.
This can trade longer waits for lower API costs; savings and quality have not been measured across representative jobs.
Budget checks may stop retries before fallback.
A failure stays in the job context with its source and error.
If a complete transcript exists, the reader can regenerate only the article, with the additional cost stated.
The server permits at most two accepted regeneration attempts per failed job, excluding the initial generation.
Failed attempts count; the allowance is saved before work starts and survives restarts.
At the limit, the interface explains why regeneration is unavailable.
For older jobs, distinct recorded article operations count against the allowance; the first is excluded only when usage history is complete.
Partial histories count all known operations conservatively.
Automatic API retries within one operation count together.
If no history exists, earlier regeneration attempts are unknown and the counter starts at zero.
This cap does not limit new jobs or fix restart recovery.
Completed articles cannot be regenerated or have their content and reading state cleared through the retry endpoint.
Returning to the form restores the source, language, and length.
A transient status-fetch failure offers a read-only status check that creates no new job.
An ambiguous regeneration response also requires checking the saved job status before another paid retry is offered; the server may already have accepted the request.
A missing job does not offer regeneration or imply that processing is still running.
See [PR 48](https://github.com/rogierslag/podcast2article/pull/48).

**Critical states and trust.**
Progress is a processing indicator, not an ETA.
The user needs to distinguish a slow request, failure, and unavailable service.
Manual failures remain absent from the active-job shelf, so a failed job can be hard to rediscover after leaving its page.
A restart queues unfinished jobs through the full pipeline, even when a transcript exists.
[Issue 54](https://github.com/rogierslag/podcast2article/issues/54) proposes durable stage recovery; it is not implemented by the current restart behavior.
Unknown API charges must remain unknown.

**Value test.**
Leave an active job, find it again, and observe completion.
With mocked paid APIs, fail article generation after transcription and interrupt a restart.
Count repeated requests and check whether a reader can recover from the visible state.
Faster concurrency has value only if completion, storage use, and recovery cost remain acceptable.

## J4. Select, read, resume, and finish

**Implemented.**
The library separates active, unread, and collapsed read items.
Publication names, dates, and reading estimates support selection.
The reader offers contents links, progress, and a saved-section continuation action.
Owner positions are stored per account; anonymous shared-reader positions stay in that browser.
The top read toggle stays on the article; marking read from the footer returns to the library after persistence succeeds.
See [PR 18](https://github.com/rogierslag/podcast2article/pull/18), [PR 20](https://github.com/rogierslag/podcast2article/pull/20), [PR 23](https://github.com/rogierslag/podcast2article/pull/23), and [PR 53](https://github.com/rogierslag/podcast2article/pull/53).

**Critical states and trust.**
Refresh, section links, browser navigation, and returning to the top must preserve orientation.
Read status is the reader's explicit choice; scrolling to the bottom does not prove comprehension.
Loading, empty library, long headings, missing covers, narrow screens, and failed read-state saves must remain usable.
Interface preferences should not alter article content.

**Value test.**
Find a named publication among several articles, read to a given section, leave, reopen, resume, and mark it read.
Repeat using keyboard navigation and a narrow viewport.
Check the destination and focus after each transition, not only whether the button responds.

## J5. Verify without losing the article

**Implemented.**
Paragraph and quote references open a source dialog at the selected timestamp.
Owners see the transcript fragment and audio; public readers receive audio only.
Dismissal pauses audio and returns focus to the reference.
Transcript search offers an explicit no-results recovery.
See [PR 19](https://github.com/rogierslag/podcast2article/pull/19), [PR 36](https://github.com/rogierslag/podcast2article/pull/36), and [PR 39](https://github.com/rogierslag/podcast2article/pull/39).

**Critical states and trust.**
A working button is insufficient: the timestamp must reach the relevant passage and the passage must support the claim.
Missing audio, delayed playback, Escape, repeated openings, and empty searches must not trap focus or lose the paragraph.
Speaker labels are not reconciled across audio chunks; [issue 33](https://github.com/rogierslag/podcast2article/issues/33) records the need to validate attribution and replacement-model behavior.

**Value test.**
Select claims, quotes, and opposing speakers from representative recordings, including chunk boundaries.
Verify them against the audio and return to the article.
Record unsupported claims, incorrect attribution, and unusable timestamps separately from interface failures.
Citation clicks alone do not measure trust or accuracy.

## J6. Share, save, and export

**Implemented.**
Owners can create a stable anonymous permalink and export a PDF from the article's top and footer.
Mobile sharing uses the system share sheet where available, with copying as a fallback.
Signed-in recipients can save a shared article once into their own library, with independent read state and available audio.
See [PR 3](https://github.com/rogierslag/podcast2article/pull/3), [PR 42](https://github.com/rogierslag/podcast2article/pull/42), and [PR 46](https://github.com/rogierslag/podcast2article/pull/46).

**Critical states and trust.**
A public link grants only that article and its audio, never the owner's account, collection, read state, costs, or private transcript.
A saved copy has no transcript text or regeneration and survives deletion of the original.
Soft deletion hides an article and disables its public link but retains stored data; there is no trash or restore UI.
PDF timestamps link back to owner routes and may require login, so PDF export is not equivalent to an anonymous permalink.
See [PR 21](https://github.com/rogierslag/podcast2article/pull/21) and [PDF generation](../src/services/pdf.ts).

**Value test.**
Share with a signed-out browser, check a source, save as another signed-in reader, and save again.
With test-only data, delete the original and confirm the recipient's copy still reads correctly.
Inspect the exported PDF and test its links in the expected access context.
A cancelled native share must not report delivery.

Anonymous loads and estimated reads are now counted separately from explicit owner read state.
A load requires two consecutive visible seconds.
A read requires 30 seconds of visible active time and 90% scroll progress.
Owners see shared loads and estimated shared reads only in the article footer, or retrieve them through the authenticated API.
Loading failures offer a retry; public readers never see the statistics.
See [monitoring definitions](SHARED-ARTICLE-MONITORING.md).
The value test is whether a rendered visit and qualifying read increment only the intended article's counters without exposing private data.
No production baseline or evidence of improved reading outcomes has been measured.

## J7. Follow, catch up, and manage the backlog

**Implemented.**
Readers follow from a podcast article or discover a Spotify show or public RSS feed on Series.
Feed identity and available episodes are previewed before confirmation.
Following defaults to future episodes only; catch-up is explicit and restricted to the latest three episodes.
Older archive episodes are not downloaded automatically.
Active feeds are checked at startup and hourly.
The Articles menu badge counts completed articles from currently followed series since the last successfully loaded Articles overview.
The checkpoint is stored per account across devices; the first visit establishes a baseline without flagging the existing backlog.
Opening the overview clears arrivals without marking articles as read; failed loads do not clear them.
The badge refreshes every 30 seconds while visible and when returning to the app.
Five unread, queued, or processing episodes in that series trigger an automatic pause.
Reading frees capacity, but the reader must explicitly resume.
Catch-up respects capacity and preserves a manual pause.
See [PR 51](https://github.com/rogierslag/podcast2article/pull/51) and [PR 52](https://github.com/rogierslag/podcast2article/pull/52).

**Critical states and trust.**
Confirm the correct feed when discovery is ambiguous.
Show the catch-up count, paid-processing implication, pause reason, capacity, and failed jobs.
A pause stops future checks but does not cancel queued work.
Failed jobs do not consume capacity and are not retried hourly; failed feed checks are retried.
Catch-up offers only skipped episodes still in the feed’s latest three, never successive older batches.
Previously confirmed pending selections remain queued.
Following is not a promise that unavailable or private content can be recovered.

**Value test.**
Follow only new episodes, request catch-up, reach the limit, read some items, and explicitly resume.
The reader should predict which episodes will be processed and why a control is disabled.
Evaluate whether automatic arrivals become useful reading; counting followed series alone can reward an unwanted backlog.

## Assessing a feature

Before adding a feature, record its primary journey, the observed obstacle, the changed behavior, and one test that would show an improvement.
Separate a reported problem from a hypothesis.
Include the states where the change could harm accessibility, source verification, privacy, or processing cost.

The shared mark and landing composition support understanding J1; they are not evidence of better transcription.
Publication names and covers support selection in J4 and feed recognition in J7; their value should be checked with ambiguous or missing artwork.
Consistent button feedback supports every journey, while clear labels and predictable focus determine whether an action can actually be used.

## Account spending visibility

The account footer supports J2, J3 and J7 with a **Usage** button that opens a modal showing estimated spending over the preceding 30 days before the reader requests more processing.
Historical spending stays visible but is excluded from the new limit; reservations are separate from confirmed estimates.
Operator-configured exemptions retain cost tracking and show **No spending limit**.
Readers cannot change their own allowance.

**Value test.**
Compare the usage modal with stored request costs for a limited account, an exempt account and a job still processing.
Confirm that the remaining allowance includes reservations, another account's costs are inaccessible, and a failed refresh shows unavailable usage rather than a zero balance.
This is a validation criterion, not a measured product outcome.

## Measurement plan

Shared permalink loads and estimated reads now have anonymous counters; see [shared article monitoring](SHARED-ARTICLE-MONITORING.md) for definitions and limits.
Other journeys have no production funnel instrumentation.
Persisted jobs support operational snapshots, not complete behavioral histories.
The following are proposed definitions, not measured results or targets.
The product owner should choose the cohort, follow-up period, and task sample before a comparison, then review the relevant outcome and guardrails after the change.

| Measure                        | Definition and decision                                                                                                                                                                                                                                            | Available evidence and limitation                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Article availability**       | Completed generated jobs divided by accepted generated jobs in a creation cohort, measured at a fixed follow-up. Report failed and still-active counts separately. Use to judge whether capture and processing deliver a result.                                   | `Job.createdAt`, `stage`, and `completedAt`. Exclude saved shared copies and test fixtures. Include later-deleted jobs in the creation cohort so cleanup cannot improve the result artificially. Separate source types and recording lengths. |
| **Reading-task success**       | Unassisted successful attempts divided by all attempts at a predefined task, such as resuming a named section or verifying a claim and returning to its paragraph. Define the success criteria before running it; report results per task and input method.        | Moderated or observed task checks. Current storage cannot establish comprehension or unassisted success. Browser regression tests establish mechanics, not user success.                                                                      |
| **Series reading disposition** | At a fixed follow-up, classify each completed subscription-generated article as deleted, marked read, or still unread, with deletion taking precedence. Report the three shares together and active/failed jobs separately.                                        | Subscription membership plus `readAt` and `deletedAt`. Current state is a mutable proxy; reading outside the app and prior read/unread toggles are not captured. Do not optimize marked-read share by encouraging deletion.                   |
| Time to article                | Median and 90th percentile of `completedAt - createdAt` for completed generated jobs, alongside the waiting age of unfinished jobs. Diagnose availability by source and recording duration.                                                                        | Stored timestamps include queueing and interruptions. Completed-only timing hides failures, and stage-level timing requires additional records.                                                                                               |
| Cost and recovery guardrail    | Sum known API cost estimates across all jobs in the creation cohort, including failures, divided by its completed generated jobs. Report zero completions as undefined. Alongside it, report attempts with unknown cost and jobs with partial or missing coverage. | `apiUsage` records from PR 48; no invoice or infrastructure total. Restart-specific repeated work needs lifecycle evidence or controlled recovery tests; automatic API retries must not be confused with a restart.                           |
| Trust and access guardrail     | Record source-audit failures by type and boundary-test failures by route/action. An unsupported claim, wrong audio scope, exposed private field, or inaccessible critical action requires investigation even if completion improves.                               | Representative audio review plus authenticated/public and accessibility tests. Passing selected cases is not proof that every article is accurate or that the whole app conforms to WCAG.                                                     |

Do not add collection of transcript text, raw source URLs, share tokens, or account identifiers just to populate a scorecard.
Prefer existing aggregate operational data and small explicit task studies.
A future event plan should name the decision each event enables and preserve anonymous-reader boundaries.

## Open decisions and review limits

- **Recovery still has two gaps.**
  Issue 54 addresses repeated paid work after restart.
  The contextual retry now helps someone already on a failed job's page, but the library still needs a decision about rediscovering failed manual jobs.
- **Accessibility issue 31 extends beyond the known contrast fixes.**
  [PR 39](https://github.com/rogierslag/podcast2article/pull/39) strengthened theme colors and search recovery; [PR 55](https://github.com/rogierslag/podcast2article/pull/55) fixed remaining known label/version-text failures.
  Neither establishes full conformance.
  The [combined accessibility audit](ACCESSIBILITY-AUDIT.md) records fresh findings, repairs, and verification of contrast, action names, keyboard behavior, text spacing, reflow, and target sizes.
  Keep those tested states distinct from the remaining assistive-technology and media checks in [issue 31](https://github.com/rogierslag/podcast2article/issues/31).
- **Physical mobile behavior remains a separate check.**
  Native share-sheet registration, Shortcut installation, voice control, and operating-system gestures cannot be inferred from a resized desktop browser.
  The article layout now passes the 320px fallback-font regression on Linux WebKit as well.
- **Source quality needs representative audio.**
  Issue 33 covers model continuity, timestamps, and speaker attribution.
  Existing UI fixtures cannot establish the quality of real generated articles or prove a replacement model equivalent.

Update this document when these decisions or journeys change.
Keep measured results in a dated review with the cohort or scenario definition, environment, evidence, and limitations, rather than turning one test run into a permanent product claim.
