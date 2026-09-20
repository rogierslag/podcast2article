# Podcast2Article Architecture

Document version: 2026-09-19

This document describes the application architecture of Podcast2Article.
Infrastructure, deployment, security operations, recovery, and server administration are documented separately in `docs/OPERATIONS.md`.

The [service flow diagrams](docs/SERVICE-FLOWS.md) show request handling, processing, recovery, subscriptions, public sharing, and API budget enforcement.

## 1. Purpose

Podcast2Article turns a public Spotify podcast episode, YouTube video, or public Google Drive or Fathom recording into:

1. a speaker-attributed transcript with timestamps;
2. a source-grounded article;
3. clickable paragraph citations that seek to the supporting audio moment;
4. a downloadable PDF containing the article and source links.

The application is designed for a small, fixed group of trusted users rather than for public self-service.
Credentials are configured by the administrator, each user's data is isolated on disk and in the API, and the application uses three processing slots with one shared slot for downloads and FFmpeg.

## 2. System context

```text
Operator browser
    |
    | HTTPS + signed session cookie
    v
Caddy reverse proxy
    |
    | 127.0.0.1:3000
    v
Podcast2Article / Express
    |
    +-- source discovery ---------------------------------------+
    |   +-- Spotify metadata                                   |
    |   +-- Apple Podcasts / public RSS                         |
    |   +-- YouTube via yt-dlp                                  |
    |   +-- public Google Drive metadata/download               |
    |   +-- public Fathom recordings via yt-dlp                 |
    |                                                           |
    +-- media processing                                        |
    |   +-- bundled FFmpeg                                      |
    |                                                           |
    +-- OpenAI API ---------------------------------------------+
    |   +-- diarized transcription                              |
    |   +-- source-grounded article generation                  |
    |                                                           |
    +-- local persistence                                       |
        +-- JSON job records                                    |
        +-- normalized MP3 media                                |
                                                                |
GitHub webhook -> isolated webhook receiver -> update mechanism-+
```

The transcription and article models run remotely through the OpenAI API.
The VPS performs source resolution, download, audio normalization, chunking, orchestration, persistence, HTML delivery, and PDF generation.

## 3. Runtime components

### 3.1 Browser interface

The browser interface consists of static HTML, CSS, images, and vanilla JavaScript under `public/`.
Owner pages require authentication when configured; public reader assets and capability routes are registered before that boundary.
After authentication, unknown page GET and HEAD requests redirect to `/articles`, including unknown HTML paths.
Logged-out page visitors still go to `/login`; unmatched API or shared paths and unsupported methods do not use the overview redirect.

The interface provides:

- login and logout;
- job submission;
- live processing status;
- completed article overview;
- private 30-day spending and budget summary in the account footer;
- read/unread state;
- transcript and audio playback;
- timestamp seeking through URL fragments;
- article-only retry;
- PDF export;
- anonymous permalinks and saving shared articles;
- reading progress and continuation;
- podcast series subscriptions.

The article source links use fragments shaped like:

```text
#job=<job-uuid>&time=<seconds>
```

The client resolves the job audio endpoint and seeks the audio player to the specified timestamp.

### 3.2 HTTP application

`src/server.ts` creates an Express 5 server bound to `127.0.0.1:3000` in production.
It is not directly exposed to the internet.
Caddy is the only public HTTP entry point.

Important middleware decisions:

- JSON bodies are limited to 32 KiB.
- Form bodies are limited to 2 KiB.
- `X-Powered-By` is disabled.
- only loopback proxies are trusted;
- most API routes return JSON errors; monitoring validation uses HTTP status codes;
- unauthenticated owner-page requests are redirected to `/login`;
- public capability routes validate their token and return `404` when unavailable.

The unauthenticated health endpoint is intentionally small:

```text
GET /api/health -> {"ok":true,"deployment":{"status":"unknown","runningCommit":null,"targetCommit":null,"lastCheckedAt":null}}
```

The updater uses `ok` for availability independently of deployment freshness.
Freshness reads local updater state, never GitHub per request.
See the [deployment-status contract](docs/DEPLOYMENT-STATUS.md) for timing, states, and required host installation.
It exposes no logs, user data, or secrets.

### 3.3 Authentication

Authentication is implemented in `src/services/auth.ts`.

- `APP_USERS` is a JSON object containing fixed usernames and passwords.
- An unset or blank `APP_USERS` disables authentication.
  Local development then uses the `local` account; production must configure accounts.
- Password comparison is timing-safe.
- The complete credential configuration derives the session signing key using `scrypt`.
- A successful login produces a signed, 30-day `HttpOnly` cookie containing the username.
- The cookie uses `SameSite=Lax`.
- Caddy supplies HTTPS, so production cookies include `Secure`.
- Changing `APP_USERS` invalidates all existing sessions.
- Five failed attempts from one IP block new attempts for 15 minutes.
- Login attempts are stored in memory and reset after a process restart.

The application has no user database, self-service registration, account recovery, or roles.
Every authenticated user has the same capabilities, but owner job, article, transcript, PDF, and audio access is scoped to that user.
Public capability URLs grant access only to their completed article and audio, and permit anonymous monitoring events for that article.

### 3.4 Job manager and queue

`src/services/jobs.ts` owns job lifecycle, persistence, recovery, and concurrency.

Metadata resolution has three independent FIFO slots, so queued jobs acquire recognizable titles and artwork without waiting for audio processing.
Resolved jobs wait in `queued` with their metadata persisted.

Full jobs and article-only retries share three processing slots.
Downloading, normalization, and splitting share one media slot because downloaders can also invoke FFmpeg.
That slot is released before transcription: remote transcription and article requests can overlap across jobs without concurrent media processing.
Chunks within each job are still transcribed sequentially.
Up to three jobs can retain temporary audio at once, so disk use can exceed the former serial queue.
Slot waits are abortable and slots are released on both success and failure.

The persisted job record is updated at important boundaries.
Job files are written as formatted JSON under `data/users/<username>/jobs/<uuid>.json`.
Series configuration, seen episode keys, and pending selections are stored separately in `data/users/<username>/subscriptions.json`.

On startup:

1. every stored job is loaded into memory;
2. completed, failed, and deleted jobs are not scheduled;
3. incomplete jobs are reset to `queued`;
4. resumable jobs enter the processing pipeline;
5. the full pipeline runs again, including media preparation and transcription.

A stored transcript does not yet provide durable stage recovery.
Restarting incomplete jobs can therefore repeat paid work.

On shutdown:

1. the HTTP server stops accepting work;
2. active OpenAI requests receive an `AbortSignal`;
3. interrupted work returns to a resumable queued state;
4. temporary media is removed;
5. the application forces exit after 15 seconds; systemd's 20-second stop timeout is the outer limit.

### 3.5 Source resolution

`src/services/resolver.ts` validates and resolves source URLs.

#### Spotify

Spotify is used for episode identity and metadata, not as the audio download source.
The resolver searches the public Apple Podcasts episode index and matches the title, then uses the selected result's public episode audio URL.
RSS feed fetching is a separate path used by podcast subscriptions.

Spotify-exclusive episodes without a public RSS equivalent cannot be processed.

#### YouTube

`src/services/youtube.ts` uses the bundled `youtube-dl-exec`/yt-dlp integration to inspect metadata and download the best available audio stream.

Supported sources include public videos, Shorts, and completed livestreams.
Playlists, active or scheduled livestreams, private content, and content that requires authentication are rejected.

#### Google Drive recordings

Public Google Drive file links are resolved without Google authentication.
The file must be accessible to anyone with the link and permit download.
Meet room links, Drive folders, and Calendar links do not point directly to media and are not accepted.

#### Fathom

Public `fathom.video/share/...` links are resolved through yt-dlp.
Private calls, team-only access, cookies, and existing Fathom summaries or transcripts are not imported.
Recordings follow the same local audio and transcription pipeline.

### 3.6 Media pipeline

`src/services/audio.ts` uses `ffmpeg-static` to resolve the executable.
By default this is the bundled binary; `FFMPEG_BIN` selects an alternative absolute path.
`src/services/fathom.ts` uses the same resolver for yt-dlp's FFmpeg location.
A system FFmpeg package is not required.
The production installer provisions a versioned Linux x64 build from a checksum-pinned manifest; local development continues to use the bundled binary unless explicitly overridden.

Fathom HLS downloads can invoke FFmpeg inside yt-dlp to remux MPEG-TS into MP4 before the application starts audio normalization.
A failure in that postprocessing step therefore appears in the application's `downloading` stage.
Postprocessing errors have a separate, localized error key from access or size failures; raw downloader diagnostics and signed URLs are never returned.

The updater runs a synthetic MPEG-TS → MP4 → MP3 → playable chunks test as the application user, using the registered service environment and candidate release code, before switching the live symlink.
A native crash therefore blocks activation even when unit tests and HTTP health pass.
FFmpeg selection survives application rollbacks and has its own guarded rollback.
See the [runtime runbook](docs/FFMPEG.md) and [2026-08-28 incident](docs/incidents/2026-08-28-fathom-ffmpeg.md).

For each job:

1. source media is streamed to a per-job work directory;
2. FFmpeg performs one normalization pass;
3. output becomes mono, 16 kHz, 48 kbps MP3;
4. the normalized MP3 is split into transcript chunks with stream copy;
5. chunks are uploaded sequentially to OpenAI;
6. the original download and temporary chunks are removed;
7. the normalized MP3 becomes persistent playback media.

Stream-copy splitting avoids a second encode.
At 48 kbps, one hour of retained audio is approximately 22 MB.

The default chunk duration is five minutes.
Each chunk is checked against the OpenAI upload-size constraint before transcription.

### 3.7 OpenAI integration

`src/services/openai.ts` performs two separate operations:

- diarized transcription with speaker labels and timestamps;
- article generation from the completed transcript and source metadata.

Audio chunks are opened with filesystem read streams rather than loaded fully into application memory.
Chunks are transcribed sequentially.

Article generation uses one writing stage, with instructions to survey the whole transcript, allocate space across its main topics, preserve defining examples and qualifications, and check for omissions before returning the article.
The transcript remains the only factual source.
There is no separate outline request or word-count correction loop.
The [coverage evaluation](docs/ARTICLE-COVERAGE-EVALUATION.md) records the comparison behind this prompt and its limits.
Language selection, length targets, source-ID checks, literal-quote validation, and the existing service-tier retry policy still apply.

Editorial instructions and input labels are written in English.
The Responses API request places editorial and article-language directives in `instructions`; episode metadata and the complete transcript are sent separately as an `input` message with `role: "user"`.
The requested article language remains independent: `auto` follows the transcript's dominant language, and an explicit selection requests the chosen language.

The selected API region is controlled by `OPENAI_REGION`.
Configuring `eu` or `us` selects the corresponding endpoint, but actual data-residency eligibility also depends on the OpenAI project, model, and feature configuration.

If transcription succeeds but article generation fails, the article-only retry endpoint reuses the stored transcript and avoids retranscription costs.
It is restricted to failed jobs and at most two accepted retries per job, including failed attempts.
Completed jobs cannot be regenerated through this endpoint.

### 3.8 PDF generation

`src/services/pdf.ts` creates A4 PDFs directly with PDFKit.

- No browser engine is required for production PDF generation.
  Playwright installs browsers separately for development tests and brand-asset generation.
- PDF generation is a short-lived in-process operation.
- Page numbers and article styling are applied directly.
- Source citations remain clickable.
- The final PDF is buffered briefly before the HTTP response is sent.

This design substantially reduces memory usage compared with browser-based printing.

### 3.9 Persistence

The application deliberately does not use a database.

```text
data/users/<username>/jobs/<uuid>.json   job, transcript, article, read state, share analytics
data/users/<username>/media/<uuid>.mp3   normalized playback audio
data/users/<username>/work/<uuid>/       temporary downloads and chunks
data/users/<username>/subscriptions.json series configuration and scheduling state
data/article-backups/<username>/<uuid>.sha256 successful S3 upload receipt
```

In production, `data` is a symlink to `/var/lib/podcast2article`.
This keeps mutable data outside immutable application releases.

`src/services/stored-jobs.ts` normalizes older job files at the storage boundary.
It maps Spotify-only source fields to the generic source model and removes the aliases from loaded jobs.
New jobs and subsequent writes use only the generic fields.
Completion timestamps and paid-retry allowances are recovered where older records lack them; article content and user reading state are preserved.
Backup extraction also accepts older files directly, so an offline backup does not require rewriting the library first.

New processing messages store semantic translation keys and separate `messageValues` for progress counts and waiting times.
API responses translate these for the reader's language.
Service failures use typed `DomainError` codes and structured interpolation values; the API boundary selects HTTP statuses and Dutch or English messages without inspecting diagnostic text.
Unknown failures return a safe localized fallback, and failed jobs persist a message key rather than raw internal error text.
Previously stored Dutch messages remain readable through the explicit `translateStoredMessage` compatibility path.
OpenAI callbacks emit typed processing events; waiting events carry elapsed seconds and, for transcription, the chunk identity independently of operational log wording.
Downloader adapters still classify external tool diagnostics at their boundary, then propagate domain errors by identity.

JSON persistence is simple and inspectable, but it does not provide database transactions, multi-process coordination, querying, or horizontal scaling.
The architecture assumes exactly one application process.
Job writes use an atomic rename so the backup worker cannot read a partially written record.
Optional S3 backups select final article fields only; receipts prevent unchanged uploads and local completed jobs provide restart recovery.
See [article backups](docs/ARTICLE-BACKUPS.md).

### Podcast subscriptions

`src/services/subscriptions.ts` persists subscription mutations atomically and serializes operations per user.
Active feeds are checked at startup and hourly.
Following defaults to future episodes only; explicit catch-up is limited to the feed's latest three.
Polling excludes dated episodes published before following.
Undated entries must precede a known episode in feed order to qualify as new.

Five unread, queued, or processing jobs pause a series.
Read, deleted, and failed jobs free capacity, but resuming requires an explicit action.
Existing confirmed pending selections survive restarts; this policy change does not cancel jobs or previously confirmed selections.
See [the series guide](README.md#following-podcast-series).

### API usage accounting

Each new job has an `apiUsage` ledger.
The OpenAI boundary persists a pending attempt before sending and its usage immediately after receiving a response, before article parsing and validation.
Each automatic retry is a separate attempt under the same operation ID; SDK retries are disabled to avoid invisible attempts.
Article generation defaults to explicit `flex`: three attempts on transient failures, followed by up to three explicit `default` attempts.
All six share an operation ID.
`ARTICLE_SERVICE_TIER=default` disables Flex and permits three standard attempts.
Transcription retains three attempts.
The wrapper honors retry headers and exponential backoff; permanent errors and shutdown cancellation stop without fallback.
The per-attempt article timeout and budget checks apply to both tiers.
A successful response that fails article validation is not retried here.

The ledger stores numeric usage counters, reported audio duration, requested and actual model/tier, request IDs, timestamps, and HTTP outcomes.
It excludes prompts, response text, credentials, and error bodies.
Job writes are serialized to prevent progress updates from overwriting accounting records.
Article retries and restart recovery preserve the ledger.
A hard stop leaves pending attempts with unknown cost.

Known USD estimates are summed separately from unknown-cost attempts.
Price snapshots are stored in `src/services/api-usage.ts` with their source and date (2026-09-19), covering diarization, Terra, and Sol.
Diarization uses the published per-minute estimate applied to reported seconds.
Article models use reported tokens, cache reads/writes, actual service tier, the [272K context boundary](https://developers.openai.com/api/docs/models/gpt-5.6-terra), and regional uplift.
These are estimates, excluding infrastructure and invoice-level adjustments.
Unsupported models, custom endpoints, and missing usage remain unknown.
Legacy jobs have unknown history; tracking initiated later is marked partial.
Public payloads and saved shared copies never include the source owner's ledger.

### Account budgets

`src/services/account-budget.ts` aggregates the existing request ledger across all of an account's jobs, including failed and deleted jobs, over the preceding 30 days.
It reports confirmed estimates separately from reservations.
Historical requests without `reservedCostUsd` remain visible but do not consume the USD 5 allowance.
New paid attempts persist a conservative reservation before sending; automatic retries reserve separately.
Article output is capped at 16,384 tokens.
Confirmed usage replaces reservations; unknown outcomes retain them until they age out.

The synchronous check and reservation update prevent concurrent jobs in the same process from reusing budget.
Startup loads all histories before resuming work and fails closed on unreadable job files.
Multiple servers sharing data are unsupported.

`GET /api/account-budget` requires authentication, uses only the session account, sets `Cache-Control: no-store`, and returns `windowDays`, `spentUsd`, `historicalSpendUsd`, `countedSpendUsd`, `reservedUsd`, `unknownCostRequests`, `limitUsd` and `remainingUsd`.
It exposes no job IDs or provider request details.
`public/account-budget.js` refreshes this summary every 30 seconds and on focus.

`SPENDING_LIMIT_EXEMPT_USERS` is an operator-managed comma-separated list of exact account names.
Exempt accounts have null limits and continue tracking costs; revocation includes their recent new spending.
Unknown-price exempt requests retain USD 5 reservations for future revocation.
Limited accounts cannot start requests with unverified reservation prices.
Credentials and exemptions are separate settings.

### Shared permalink monitoring

`public/share-analytics.js` counts visible reading time, and `public/share.js` sends credential-free `load` and `read` events after rendering.
Loads require two consecutive visible seconds; hidden or suspended time resets that window.
Browsers declaring `navigator.webdriver === true` send no monitoring events.
Reads require 30 seconds of active visible time and 90% scroll progress.
The public POST endpoint validates the capability and event schema; the server also enforces 30 seconds between the load and read.

`src/services/share-analytics.ts` updates aggregate counts and up to 256 recent visit receipts per job.
Receipts store a random visit ID's digest, load time, and read flag, with a 24-hour deduplication window.
Job persistence keeps the totals and receipts across restarts.
An owner-only endpoint returns the aggregate fields for the owner article footer.
The footer refreshes on article opening and tab return, guards against stale responses after navigation, and offers a retry on failure; public article payloads and saved copies omit the original analytics.

See [shared article monitoring](docs/SHARED-ARTICLE-MONITORING.md) for request and response contracts, pruning, and limits.
These are approximate visit counts; client events cannot establish unique readers or comprehension.

## 4. Processing lifecycle

```text
queued
  -> resolving
  -> queued (metadata ready; waiting for processing and media slots)
  -> downloading (download, normalization, and splitting)
  -> transcribing
  -> writing
  -> complete

Any non-shutdown error -> failed
Graceful shutdown      -> queued for restart
```

Detailed flow:

1. Validate source URL, language, and requested article length.
2. Persist a new queued job with a UUID.
3. Resolve the public source in a metadata slot and persist its title and artwork.
4. Wait for a processing slot and the media slot.
5. Enforce the source-specific download limit.
6. Download the source to the temporary work directory.
7. Normalize once to compact playback MP3.
8. Split by stream copy and release the media slot.
9. Transcribe each chunk and merge timestamped segments.
10. Move normalized audio to persistent media storage.
11. Generate the source-grounded article.
12. Persist the completed job and completion timestamp.
13. Remove the work directory.

## 5. API surface

| Method   | Path                             | Purpose                                    | Authentication |
| -------- | -------------------------------- | ------------------------------------------ | -------------- |
| `GET`    | `/s/:token`                      | Anonymous article page and social metadata | Capability     |
| `GET`    | `/api/shared/:token`             | Shaped public article payload              | Capability     |
| `GET`    | `/api/shared/:token/audio`       | That article's source audio                | Capability     |
| `POST`   | `/api/shared/:token/events`      | Record anonymous load/read                 | Capability     |
| `GET`    | `/share-target`                  | Prefill an incoming source                 | No             |
| `GET`    | `/api/health`                    | Deployment health                          | No             |
| `GET`    | `/login`                         | Login form                                 | No             |
| `POST`   | `/login`                         | Create session                             | No             |
| `POST`   | `/logout`                        | Expire session                             | Yes            |
| `GET`    | `/api/deployment-status`         | Deployment failure flag                    | Yes            |
| `GET`    | `/api/auth`                      | Report auth state                          | Yes            |
| `GET`    | `/api/account-budget`            | Account spending and reserved allowance    | Yes            |
| `GET`    | `/api/articles`                  | List completed articles                    | Yes            |
| `PATCH`  | `/api/articles/:id`              | Set read/unread state                      | Yes            |
| `DELETE` | `/api/articles/:id`              | Soft-delete article and disable sharing    | Yes            |
| `PATCH`  | `/api/jobs/:id/reading-position` | Save continuation section                  | Yes            |
| `POST`   | `/api/jobs/:id/share`            | Create or reuse permalink                  | Yes            |
| `GET`    | `/api/jobs/:id/share-stats`      | Owner's shared load/read totals            | Yes            |
| `GET`    | `/api/saved-shares/:token`       | Find a previously saved copy               | Yes            |
| `POST`   | `/api/saved-shares/:token`       | Save an independent copy once              | Yes            |
| `GET`    | `/api/jobs`                      | List active jobs                           | Yes            |
| `POST`   | `/api/jobs`                      | Create a job                               | Yes            |
| `GET`    | `/api/jobs/:id`                  | Read one job                               | Yes            |
| `GET`    | `/api/jobs/:id/audio`            | Stream normalized MP3                      | Yes            |
| `GET`    | `/api/jobs/:id/pdf`              | Generate article PDF                       | Yes            |
| `POST`   | `/api/jobs/:id/retry-article`    | Reuse transcript and rewrite               | Yes            |

“Yes” means the configured owner session is required; without account configuration, local development uses the `local` account.
“Capability” means a valid high-entropy token, independent of account authentication.

`POST /api/jobs` requires `sourceUrl`, with optional `language` and `articleLength`.
The former `spotifyUrl` request alias is no longer accepted as a source.
Owner and public responses use generic source fields only.

Series routes are authenticated and scoped to the current user:

| Method  | Path                              | Purpose                                         |
| ------- | --------------------------------- | ----------------------------------------------- |
| `GET`   | `/api/subscriptions`              | List followed series and capacity               |
| `GET`   | `/api/subscriptions/article/:id`  | Resolve an article's follow status              |
| `POST`  | `/api/subscriptions/discover`     | Find public podcast feeds                       |
| `POST`  | `/api/subscriptions/preview`      | Review a feed before following                  |
| `POST`  | `/api/subscriptions`              | Follow with `backfill: "none"` or `"three"`     |
| `POST`  | `/api/subscriptions/:id/backfill` | Request eligible episodes from the latest three |
| `PATCH` | `/api/subscriptions/:id`          | Pause or explicitly resume                      |

The former `latest` and `ten` backfill request values are rejected.
Existing subscription files remain readable without a migration.

`POST /hooks/github` is not handled by the application.
Caddy routes it to a separate, restricted webhook receiver.
See [operations](docs/OPERATIONS.md).

## 6. Configuration contract

Production application configuration is stored in `/etc/podcast2article.env`.
Values must never be committed or copied into this document.

| Variable                          | Role                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                  | OpenAI API credential                                                                                     |
| `APP_USERS`                       | JSON object with fixed username/password pairs                                                            |
| `SPENDING_LIMIT_EXEMPT_USERS`     | Comma-separated exact usernames exempt from spending limits                                               |
| `OPENAI_REGION`                   | `global`, `eu`, or `us` API endpoint                                                                      |
| `OPENAI_BASE_URL`                 | Advanced endpoint override; custom endpoints have no verified cost estimate or budget reservation pricing |
| `HOST`                            | Production bind address; currently loopback                                                               |
| `PUBLIC_BASE_URL`                 | Canonical external origin for permalink and social metadata URLs                                          |
| `PORT`                            | Production HTTP port; currently 3000                                                                      |
| `NODE_ENV`                        | Production runtime mode                                                                                   |
| `ARTICLE_MODEL`                   | Article-generation model                                                                                  |
| `ARTICLE_SERVICE_TIER`            | Article tier: `flex` (default, with standard fallback after three transient failures) or `default`        |
| `TRANSCRIPTION_MODEL`             | Diarized transcription model                                                                              |
| `MAX_AUDIO_MB`                    | Spotify/RSS source limit                                                                                  |
| `MAX_YOUTUBE_MB`                  | YouTube source limit                                                                                      |
| `MAX_RECORDING_MB`                | Google Drive or Fathom recording limit                                                                    |
| `YOUTUBE_METADATA_TIMEOUT_MS`     | Metadata timeout                                                                                          |
| `MEDIA_DOWNLOAD_TIMEOUT_MS`       | Download timeout                                                                                          |
| `FFMPEG_BIN`                      | Optional absolute path overriding the bundled FFmpeg executable                                           |
| `AUDIO_CHUNK_SECONDS`             | Transcript chunk duration                                                                                 |
| `OPENAI_TRANSCRIPTION_TIMEOUT_MS` | Per-chunk API timeout                                                                                     |
| `OPENAI_ARTICLE_TIMEOUT_MS`       | Article API timeout                                                                                       |
| `LOG_STACKS`                      | Enable full stack traces in logs                                                                          |

S3 backups use `ARTICLE_BACKUP_BUCKET` (empty disables backups), `ARTICLE_BACKUP_REGION` (required when enabled), `ARTICLE_BACKUP_PREFIX` (default `articles`) and the standard AWS credential chain.

## 7. Dependency model

Production dependencies:

- Express for HTTP;
- AWS SDK for private S3 article backup uploads and operator restores;
- Zod for input validation;
- fast-xml-parser for podcast feeds;
- youtube-dl-exec for YouTube and Fathom acquisition;
- ffmpeg-static for media processing;
- OpenAI SDK for transcription and article generation;
- PDFKit for PDF export.

Runtime requirements:

- Node.js 24 or newer;
- Python 3.11 or newer for yt-dlp;
- outbound HTTPS access.

No database, browser engine, container runtime, or system FFmpeg is required.

## 8. Source tree

```text
public/                    browser UI and static assets
src/server.ts              Express composition and routes
src/types.ts               shared application types
src/lib/logger.ts          structured operational logging
src/lib/network.ts         bounded network operations
src/services/auth.ts       password and signed-cookie authentication
src/services/resolver.ts   Spotify/Drive resolution and source dispatch
src/services/youtube.ts    YouTube metadata and download
src/services/fathom.ts     public Fathom metadata and download
src/services/podcast-feeds.ts RSS feed discovery and parsing
src/services/audio.ts      FFmpeg normalization and splitting
src/services/openai.ts     transcription and article generation
src/services/jobs.ts       queue, persistence, lifecycle, recovery
src/services/api-usage.ts  request ledger and stored cost estimates
src/services/account-budget.ts rolling allowance and operator exemptions
src/services/pdf.ts        PDFKit export
src/services/share-analytics.ts anonymous visit deduplication and counters
src/services/subscriptions.ts per-user series scheduling and persistence
scripts/                   production updater and webhook receiver
deploy/                    systemd, Caddy, cron, and logrotate definitions
```

## 9. Testing and validation

The standard validation command is:

```bash
yarn run check
```

It performs:

1. Prettier formatting verification;
2. ESLint validation;
3. TypeScript compilation;
4. the Vitest application suite;
5. Node tests, including authenticated/public HTTP boundaries, monitoring, browser helpers, deployment, and webhook validation.

Frontend changes also require `node --check public/app.js`, `node --check public/share.js`, and `git diff --check`.
Browser and media tests run separately; see [development](README.md#development).

The production updater installs locked dependencies and runs `yarn run check`, including formatting, lint, compilation, Vitest, and Node tests.
It separately runs the synthetic media preflight before activation; it does not run Playwright or wait for GitHub Actions.
After activation, it requires the service and local health endpoint to become healthy.
On failure it restores the previous release when one exists; a first deployment has no earlier release to restore.

## 10. Architectural constraints and known limitations

- Designed for a small fixed user group and three globally active processing jobs with serial media preparation.
- Accounts are administrator-managed environment configuration, not a user database.
- Job files are local JSON rather than transactional database records.
- Horizontal scaling is not supported.
- Source availability depends on public third-party endpoints.
- Speaker identity can vary across separate transcription chunks.
- Model output must be reviewed before publication.
- Public availability of a recording does not itself grant republication rights.
- Retained media and transcripts may contain personal or sensitive information.
- Optional S3 article backups use `src/services/article-backups.ts` and explicit versioned payloads.
  A worker scans atomically persisted completed jobs after completion, at startup and every minute; destination/content receipts skip unchanged uploads.
  Failed uploads never change generation status.
  See [article backups](docs/ARTICLE-BACKUPS.md) for configuration and recovery.
  Full account, configuration and media backups remain an infrastructure concern.

## 11. Key architectural decisions

### Native service rather than Docker

The application runs directly under systemd to minimize moving parts and overhead on the one-GB VPS.
Dependencies are sufficiently self-contained that a container provides limited additional benefit for this deployment.

### PDFKit rather than Chromium

Direct PDF construction avoids a large browser runtime and reduces memory pressure.

### Normalize once, split with stream copy

One FFmpeg encode creates the retained MP3.
Transcript chunking then copies the encoded stream without another CPU-heavy pass.

### Bounded concurrency

Three processing slots overlap remote API waits.
One media slot keeps downloads and FFmpeg serial on the V1 server.
Independent metadata slots let the queue show titles and artwork before media processing begins.

### Immutable releases and external mutable data

Application releases can be switched or rolled back atomically while jobs and media remain under `/var/lib/podcast2article`.

### Separate webhook receiver

Caddy never executes deployment commands.
The receiver authenticates GitHub and can only create a fixed trigger file.
A root-owned systemd service then runs the hard-coded updater.
