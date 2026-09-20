# Service flows

Podcast2Article turns public recordings into articles through a persisted job
queue. These diagrams describe the current implementation, including the paths
that stop processing or restrict access. They render in GitHub's Markdown viewer.
For user outcomes, see [user journeys](USER-JOURNEYS.md); for configuration and
recovery procedures, see the [README](../README.md) and [operations guide](OPERATIONS.md).

## Submit and process a recording

The owner submits a source URL, article language, and article length. A job is
saved before it enters the queue, so an accepted request survives a restart.
The browser polls job and library endpoints while processing continues. Duplicate
detection matches source, language, and length within the account and ignores
failed or deleted jobs.

```mermaid
flowchart TD
    Submit["POST /api/jobs"] --> Auth{"Owner session valid<br/>or auth disabled?"}
    Auth -->|No| Unauthorized["401: sign in"]
    Auth -->|Yes| Validate{"Valid request<br/>and API key available?"}
    Validate -->|Invalid input| Invalid["400: correct input"]
    Validate -->|Missing API key| Unavailable["503: processing unavailable"]
    Validate -->|Yes| Duplicate{"Matching job exists?"}
    Duplicate -->|Yes| Existing["409: return existing job ID"]
    Duplicate -->|No| Budget{"Account budget available?"}
    Budget -->|No| Limited["429: processing limit reached"]
    Budget -->|Yes| Persist["Persist queued job<br/>202: accepted"]
    Persist --> Resolve["Resolve metadata<br/>3 lookup slots"]
    Resolve --> Wait["Save metadata<br/>Wait for slots"]
    Wait --> Download["Download media"]
    Download --> Prepare["FFmpeg: normalize<br/>and split audio"]
    Prepare --> Transcribe["Transcribe chunks<br/>with OpenAI"]
    Transcribe --> SaveTranscript["Save transcript<br/>and playback audio"]
    SaveTranscript --> Write["Generate and<br/>validate article"]
    Write --> Complete["Save article<br/>in owner library"]
```

Spotify resolution matches episode metadata against the Apple Podcasts index
and uses the matched public audio URL; it does not download Spotify audio.
YouTube and Fathom use yt-dlp. Drive uses public file metadata and downloads.
RSS subscription jobs already carry server-resolved episode metadata.

There are three processing slots shared by full jobs and article retries.
Downloads and FFmpeg share a single media slot. Metadata resolution happens
before acquiring a processing slot, allowing queued titles and images to appear
while other jobs transcribe or generate articles. Temporary files are removed
when the run finishes or fails; retained playback audio and job JSON live under
`data/users/<username>/`.

Sources: [request routes](../src/server.ts), [job processing](../src/services/jobs.ts),
[source resolution](../src/services/resolver.ts), and [OpenAI processing](../src/services/openai.ts).

## Final article backups

When S3 backups are configured, successful local completion requests a background
scan, including after an article-only retry. Startup and a one-minute timer also
scan existing completed articles, including soft-deleted articles. Incomplete and
failed jobs are skipped. Uploads contain only the final article and identifying
metadata; destination/content receipts skip unchanged objects. Failed uploads
leave local jobs complete and retry from persisted files after restart.

See [article backups](ARTICLE-BACKUPS.md) for payload exclusions, access controls,
backfill, retention, restore limitations and cost estimates.

## Failures, retries, and server restarts

An explicit article retry and restart recovery take different paths. Only the
explicit retry reuses the stored transcript. Restart recovery currently enqueues
the full pipeline, including audio download and transcription, even if an
interrupted job already has a transcript.

```mermaid
flowchart TD
    Run["Full processing or article retry"] --> Outcome{"Run outcome"}
    Outcome -->|Success| Complete["complete"]
    Outcome -->|Processing error| Failed["failed<br/>Persist error and last progress"]
    Outcome -->|Shutdown abort| Queued["queued<br/>Persist as resumable"]
    Failed --> Retry["Owner requests<br/>article retry"]
    Retry --> Eligible{"Eligible for<br/>article retry?"}
    Eligible -->|No| Reject["Reject retry"]
    Eligible -->|Yes| Budget{"Account budget available?"}
    Budget -->|No| Reject
    Budget -->|Yes| Save["Save retry count<br/>and writing stage"]
    Save --> Article["Use saved transcript<br/>in processing slot"]
    Article --> Outcome
    Queued --> Startup["Server startup loads stored jobs"]
    Interrupted["Hard stop leaves a nonterminal stage"] --> Startup
    Startup --> Recover{"Neither complete nor failed<br/>and not deleted?"}
    Recover -->|Yes| Full["Requeue full pipeline<br/>with same ID"]
    Recover -->|No| Retain["Load without scheduling work"]
```

Retry eligibility requires a failed, inactive job with episode metadata and a
complete transcript, no saved-copy marker, and fewer than two accepted retries.
The retry count is saved before paid work starts, and failed attempts count
towards the two-retry limit. Automatic API retries within an operation are
separate from this owner-triggered allowance. Shutdown aborts active requests
and stops new work; a hard stop can leave pending usage records with unknown costs.

Sources: [retry, shutdown, and recovery helpers](../src/services/jobs.ts) and
[server shutdown](../src/server.ts).

## Follow a podcast series

Following a series stores the selected language and length, plus either no
backlog or the latest three episodes. Checks run at startup and hourly, and can
also be requested through the subscription API. Operations are serialized per
user so overlapping checks cannot overwrite subscription state.

```mermaid
flowchart TD
    Follow["Follow feed<br/>with backlog choice"] --> Store["Save subscription<br/>and episode keys"]
    Store --> Check["Startup, hourly or manual check"]
    Check --> Paused{"Paused or stopping?"}
    Paused -->|Yes| Skip["Skip automatic processing"]
    Paused -->|No| Available{"Processing available?"}
    Available -->|No| Error["Save error<br/>Keep pending episodes"]
    Available -->|Yes| Limit{"5 outstanding articles?"}
    Limit -->|Yes| Pause["Persist pause with limit reason"]
    Limit -->|No| Pending["Drain saved backlog<br/>within limit"]
    Pending --> Room{"Still unpaused<br/>and check has room?"}
    Room -->|No| Done["Wait for next check or owner action"]
    Room -->|Yes| Feed["Fetch feed<br/>Find new episodes"]
    Feed --> Save["Save pending episodes<br/>and check time"]
    Save --> Enqueue["Enqueue within<br/>remaining allowance"]
    Enqueue --> Commit["Save each job ID<br/>and seen episode key"]
    Commit --> EndLimit{"5 outstanding articles?"}
    EndLimit -->|Yes| Pause
    EndLimit -->|No| Done
    Feed -.->|Fetch failure| Error
    Pending -.->|Enqueue failure or budget exhausted| Error
    Enqueue -.->|Enqueue failure or budget exhausted| Error
```

Outstanding means active jobs plus unread completed articles for the series;
failed and deleted jobs do not count. Reading enough articles frees capacity,
but the owner must resume a paused subscription. Episode identity deduplication
prevents a crash between job creation and subscription persistence from creating
the same job again. New-episode selection checks publication time against the
follow date, or feed order relative to known episodes when dates are missing.
Explicit catch-up can process selected archive entries without clearing a manual pause.

Sources: [subscription store](../src/services/subscriptions.ts),
[subscription routes](../src/services/subscription-routes.ts), and
[podcast job creation and outstanding counts](../src/services/jobs.ts).

## Read, share, and save an article

Owner routes use the signed-in account's storage. Public routes resolve a
high-entropy capability token and are registered before authentication middleware.
A token grants read access only to its article and audio. It also allows anonymous
load/read events for that article; those events never change owner reading state,
grant access to the owner's library, or reveal private statistics.

```mermaid
sequenceDiagram
    actor Owner
    participant Private as Owner API (session required)
    participant Store as Per-user job and media storage
    actor Reader
    participant Public as Public share routes
    Owner->>Private: Read article, transcript and source audio
    Private->>Store: Look up job within owner's account
    Store-->>Owner: Article and private reading context
    Owner->>Private: POST /api/jobs/:id/share
    Private->>Store: Require completed article, persist token if missing
    Private-->>Owner: Stable /s/:token URL
    Owner-->>Reader: Share permalink
    Reader->>Public: GET /s/:token
    Public->>Store: Resolve token to completed, nondeleted article
    alt Token does not resolve
        Public-->>Reader: Public 404, without login redirect
    else Valid token
        Public-->>Reader: Reader HTML with server-rendered social metadata
        Reader->>Public: GET /api/shared/:token
        Public-->>Reader: Article, selected episode fields, source IDs and start times
        Reader->>Public: GET /api/shared/:token/audio
        Public-->>Reader: This article's retained audio, or 404 if missing
        opt No declared WebDriver automation and two consecutive visible seconds
            Reader->>Public: POST /api/shared/:token/events (load)
            Public->>Store: Deduplicate visit and persist load count
            Public-->>Reader: 204, no statistics in response
            opt 30 seconds of active visible reading and 90 percent progress
                Reader->>Public: POST /api/shared/:token/events (estimated read)
                Public->>Store: Require recent load and 30 elapsed seconds, persist once
                Public-->>Reader: 204, no owner read-state change
            end
        end
        opt Reader signs in and saves a personal copy
            Reader->>Private: POST /api/saved-shares/:token
            Private->>Store: Reuse existing copy or save article and available audio
            Private-->>Reader: Own copy with independent reading state
        end
    end
    Owner->>Private: GET /api/jobs/:id/share-stats
    Private->>Store: Read only this owner's aggregate counts
    Private-->>Owner: Shared loads and estimated shared reads in article footer
```

Public payloads omit the username, internal job ID, token, reading state, usage
ledger, monitoring statistics, and transcript text. Saved copies retain only
source IDs and timestamps, not the private transcript, original owner's costs,
or analytics. Owner-only actions include
marking read, saving reading position, PDF export, and soft deletion. Soft deletion
hides the original from token lookup; public responses already cached may remain
available until their cache lifetime expires.
The owner footer loads counts when opening or returning to the article. A failed
request shows a retry action rather than zero. Reading through the owner's
library does not count; opening the public permalink can count even for its owner.
The two-second load delay is enforced by the browser, and
`navigator.webdriver === true` disables both events without blocking reading.
These checks filter some previews, but a capable crawler or direct event POST
can still affect totals. Load/read counters measure visits, not unique readers
or comprehension. Their deduplication window and client/server checks are described in
[shared article monitoring](SHARED-ARTICLE-MONITORING.md).

Sources: [public and owner routes](../src/server.ts),
[share tokens and copy persistence](../src/services/jobs.ts), and
[public reader](../public/share.js).

## Reserve and record API costs

Accepting a job does not reserve its entire future cost. Each transcription or
article API attempt must persist its own reservation before the request is sent.
This also applies to automatic API retries. Article requests default to Flex,
with three attempts before switching to explicit standard processing for up to
three more attempts. Both tiers share one operation ID. Only transient failures
are retried; cancellation and permanent errors stop immediately.
`ARTICLE_SERVICE_TIER=default` skips Flex and keeps three standard attempts.

```mermaid
flowchart TD
    Attempt["Next OpenAI request attempt"] --> Estimate["Estimate maximum request cost"]
    Estimate --> Allowed{"Exempt or within<br/>verified allowance?"}
    Allowed -->|No| Block["Block request<br/>with budget error"]
    Allowed -->|Yes| Persist["Save pending usage<br/>and reservation"]
    Persist --> Send["Send OpenAI request"]
    Send --> Result["Record outcome<br/>and usage"]
    Result --> Known{"Cost known?"}
    Known -->|Yes| Cost["Count known cost"]
    Known -->|No| Reserve["Keep reservation"]
    Cost --> Summary["Owner account-budget summary"]
    Reserve --> Summary
```

The allowance is USD 5 over the preceding 30 days unless the operator exempts
the account. Historical requests without reservations do not consume this
allowance. Failed and deleted jobs still contribute their counted costs;
saving a shared article does not transfer costs. Estimates are stored with their
pricing basis and are not invoice amounts. See the
[budget runbook](OPERATIONS.md#account-processing-budget) for operational details.

Sources: [usage persistence](../src/services/jobs.ts),
[request tracking and pricing](../src/services/api-usage.ts), and
[account budget calculation](../src/services/account-budget.ts).

## Deploy a release and recover from failure

A signed push to `main` triggers the installed updater through an isolated webhook
receiver and systemd. Daily reconciliation invokes the same updater. GitHub Actions
runs separately; the updater does not wait for CI, so passing CI must be checked
before merging.

```mermaid
flowchart TD
    Push["GitHub push webhook"] --> Verify{"Valid signed<br/>main push?"}
    Verify -->|No| Ignore["Reject or ignore"]
    Verify -->|Yes| Trigger["Write trigger<br/>systemd starts updater"]
    Daily["Five-minute cron or manual systemd start"] --> Lock
    Trigger --> Lock{"Acquire updater lock?"}
    Lock -->|No| Skip["Skip update"]
    Lock -->|Yes| Revision{"Already current?"}
    Revision -->|Yes| Existing{"Service and HTTP health pass?"}
    Existing -->|Yes| Clear["Clear failure marker<br/>Keep current release"]
    Existing -->|No| Mark["Set deployment failure marker"]
    Revision -->|No| Build["Fetch and install<br/>Run yarn check"]
    Build --> Release["Prepare release<br/>and link shared data"]
    Release --> Media["Media preflight<br/>as app user"]
    Build -.->|Failure| Mark
    Release -.->|Failure| Mark
    Media -->|Failure| Mark
    Media -->|Success| Activate["Switch current symlink<br/>Restart application"]
    Activate --> Health{"Restart and<br/>health checks pass?"}
    Health -->|Yes| Success["Clear failure marker<br/>Prune old releases"]
    Health -->|No| Rollback["Restore and restart<br/>previous release if any"]
    Rollback --> Mark
```

Failures before activation leave the old process and symlink in place. A failed
first deployment has no earlier release to restore. The application updater,
systemd units, Caddy configuration, and FFmpeg selection are host infrastructure:
merging application changes does not reinstall them. Confirm the installed
updater includes the media gate before relying on it. Historical rollout and
runtime-download limitations remain documented in the
[operations guide](OPERATIONS.md) and [FFmpeg runbook](FFMPEG.md).

Sources: [updater](../scripts/update-production.sh),
[webhook receiver](../scripts/github-webhook-server.mjs),
[update path](../deploy/podcast2article-update.path), and
[infrastructure installer](../deploy/install-infrastructure.sh).
