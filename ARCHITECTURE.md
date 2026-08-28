# Podcast2Article Architecture

Document version: 2026-08-23

This document describes the application architecture of Podcast2Article.
Infrastructure, deployment, security operations, recovery, and server
administration are documented separately in `docs/OPERATIONS.md`.

## 1. Purpose

Podcast2Article turns a public Spotify podcast episode, YouTube video, or public
Google Drive recording into:

1. a speaker-attributed transcript with timestamps;
2. a source-grounded article;
3. clickable paragraph citations that seek to the supporting audio moment;
4. a downloadable PDF containing the article and source links.

The application is designed for a small, fixed group of trusted users rather
than for public self-service. Credentials are configured by the administrator,
each user's data is isolated on disk and in the API, and the application
deliberately processes only one job at a time across all users.

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

The transcription and article models run remotely through the OpenAI API. The
VPS performs source resolution, download, audio normalization, chunking,
orchestration, persistence, HTML delivery, and PDF generation.

## 3. Runtime components

### 3.1 Browser interface

The browser interface consists of static HTML, CSS, images, and vanilla
JavaScript under `public/`. Express serves these assets after authentication.

The interface provides:

- login and logout;
- job submission;
- live processing status;
- completed article overview;
- read/unread state;
- transcript and audio playback;
- timestamp seeking through URL fragments;
- article-only retry;
- PDF export.

The article source links use fragments shaped like:

```text
#job=<job-uuid>&time=<seconds>
```

The client resolves the job audio endpoint and seeks the audio player to the
specified timestamp.

### 3.2 HTTP application

`src/server.ts` creates an Express 5 server bound to `127.0.0.1:3000` in
production. It is not directly exposed to the internet. Caddy is the only
public HTTP entry point.

Important middleware decisions:

- JSON bodies are limited to 32 KiB.
- Form bodies are limited to 2 KiB.
- `X-Powered-By` is disabled.
- only loopback proxies are trusted;
- API routes return JSON errors;
- unauthenticated page requests are redirected to `/login`.

The unauthenticated health endpoint is intentionally small:

```text
GET /api/health -> {"ok":true}
```

It is used by the deployment health check. It does not expose configuration,
data, model output, or secrets.

### 3.3 Authentication

Authentication is implemented in `src/services/auth.ts`.

- `APP_USERS` is a JSON object containing fixed usernames and passwords.
- An empty account configuration disables authentication and must never be used in production.
- Password comparison is timing-safe.
- The complete credential configuration derives the session signing key using `scrypt`.
- A successful login produces a signed, 30-day `HttpOnly` cookie containing the username.
- The cookie uses `SameSite=Strict`.
- Caddy supplies HTTPS, so production cookies include `Secure`.
- Changing `APP_USERS` invalidates all existing sessions.
- Five failed attempts from one IP block new attempts for 15 minutes.
- Login attempts are stored in memory and reset after a process restart.

The application has no user database, self-service registration, account
recovery, or roles. Every authenticated user has the same capabilities, but
all job, article, transcript, PDF, and audio access is scoped to that user.

### 3.4 Job manager and queue

`src/services/jobs.ts` owns job lifecycle, persistence, recovery, and
concurrency.

Only one full job or article-only retry runs at a time. Additional work is kept
in an in-memory FIFO queue. This protects the one-vCPU, one-GB VPS from
concurrent FFmpeg and Node workloads.

The persisted job record is updated at important boundaries. Job files are
written as formatted JSON under
`data/users/<username>/jobs/<uuid>.json`.

On startup:

1. every stored job is loaded into memory;
2. completed and failed jobs remain unchanged;
3. incomplete jobs are reset to `queued`;
4. resumable jobs enter the serial queue;
5. the active processing step starts again from a safe boundary.

On shutdown:

1. the HTTP server stops accepting work;
2. active OpenAI requests receive an `AbortSignal`;
3. interrupted work returns to a resumable queued state;
4. temporary media is removed;
5. shutdown waits up to the configured service timeout.

### 3.5 Source resolution

`src/services/resolver.ts` validates and resolves source URLs.

#### Spotify

Spotify is used for episode identity and metadata, not as the audio download
source. The resolver searches the public Apple Podcasts index and the
publisher's public RSS feed for the matching episode, then uses the original
public media enclosure.

Spotify-exclusive episodes without a public RSS equivalent cannot be processed.

#### YouTube

`src/services/youtube.ts` uses the bundled `youtube-dl-exec`/yt-dlp integration
to inspect metadata and download the best available audio stream.

Supported sources include public videos, Shorts, and completed livestreams.
Playlists, active or scheduled livestreams, private content, and content that
requires authentication are rejected.

#### Google Drive recordings

Public Google Drive file links are resolved without Google authentication. The
file must be accessible to anyone with the link and permit download. Meet room
links, Drive folders, and Calendar links do not point directly to media and are
not accepted.

### 3.6 Media pipeline

`src/services/audio.ts` uses `ffmpeg-static` to resolve the executable. By
default this is the bundled binary; `FFMPEG_BIN` selects an alternative absolute
path. `src/services/fathom.ts` uses the same resolver for yt-dlp's FFmpeg
location. A system FFmpeg package is not required. The production installer
provisions a versioned Linux x64 build from a checksum-pinned manifest; local
development continues to use the bundled binary unless explicitly overridden.

Fathom HLS downloads can invoke FFmpeg inside yt-dlp to remux MPEG-TS into MP4
before the application starts audio normalization. A failure in that
postprocessing step therefore appears in the application's `downloading` stage.
Postprocessing errors have a separate, localized error key from access or size
failures; raw downloader diagnostics and signed URLs are never returned.

The updater runs a synthetic MPEG-TS → MP4 → MP3 → playable chunks test as the
application user, using the registered service environment and candidate release
code, before switching the live symlink. A native crash therefore blocks
activation even when unit tests and HTTP health pass. FFmpeg selection survives
application rollbacks and has its own guarded rollback. See the
[runtime runbook](docs/FFMPEG.md) and
[2026-08-28 incident](docs/incidents/2026-08-28-fathom-ffmpeg.md).

For each job:

1. source media is streamed to a per-job work directory;
2. FFmpeg performs one normalization pass;
3. output becomes mono, 16 kHz, 48 kbps MP3;
4. the normalized MP3 is split into transcript chunks with stream copy;
5. chunks are uploaded sequentially to OpenAI;
6. the original download and temporary chunks are removed;
7. the normalized MP3 becomes persistent playback media.

Stream-copy splitting avoids a second encode. At 48 kbps, one hour of retained
audio is approximately 22 MB.

The default chunk duration is five minutes. Each chunk is checked against the
OpenAI upload-size constraint before transcription.

### 3.7 OpenAI integration

`src/services/openai.ts` performs two separate operations:

- diarized transcription with speaker labels and timestamps;
- article generation from the completed transcript and source metadata.

Audio chunks are opened with filesystem read streams rather than loaded fully
into application memory. Chunks are transcribed sequentially.

The selected API region is controlled by `OPENAI_REGION`. Configuring `eu` or
`us` selects the corresponding endpoint, but actual data-residency eligibility
also depends on the OpenAI project, model, and feature configuration.

If transcription succeeds but article generation fails, the article-only retry
endpoint reuses the stored transcript and avoids retranscription costs.

### 3.8 PDF generation

`src/services/pdf.ts` creates A4 PDFs directly with PDFKit.

- Chromium and Puppeteer are not installed or required.
- PDF generation is a short-lived in-process operation.
- Page numbers and article styling are applied directly.
- Source citations remain clickable.
- The final PDF is buffered briefly before the HTTP response is sent.

This design substantially reduces memory usage compared with browser-based
printing.

### 3.9 Persistence

The application deliberately does not use a database.

```text
data/users/<username>/jobs/<uuid>.json   job, transcript, article, read state
data/users/<username>/media/<uuid>.mp3   normalized playback audio
data/users/<username>/work/<uuid>/       temporary downloads and chunks
```

In production, `data` is a symlink to `/var/lib/podcast2article`. This keeps
mutable data outside immutable application releases.

JSON persistence is simple and inspectable, but it does not provide database
transactions, multi-process coordination, querying, or horizontal scaling.
The architecture assumes exactly one application process.

## 4. Processing lifecycle

```text
queued
  -> resolving
  -> downloading
  -> normalizing and splitting
  -> transcribing
  -> writing
  -> complete

Any non-shutdown error -> failed
Graceful shutdown      -> queued for restart
```

Detailed flow:

1. Validate source URL, language, and requested article length.
2. Persist a new queued job with a UUID.
3. Wait for the serial queue.
4. Resolve the public source and metadata.
5. Enforce the source-specific download limit.
6. Download the source to the temporary work directory.
7. Normalize once to compact playback MP3.
8. Split by stream copy.
9. Transcribe each chunk and merge timestamped segments.
10. Move normalized audio to persistent media storage.
11. Generate the source-grounded article.
12. Persist the completed job and completion timestamp.
13. Remove the work directory.

## 5. API surface

| Method  | Path                          | Purpose                      | Authentication |
| ------- | ----------------------------- | ---------------------------- | -------------- |
| `GET`   | `/api/health`                 | Deployment health            | No             |
| `GET`   | `/login`                      | Login form                   | No             |
| `POST`  | `/login`                      | Create session               | No             |
| `POST`  | `/logout`                     | Expire session               | Yes            |
| `GET`   | `/api/auth`                   | Report auth state            | Yes            |
| `GET`   | `/api/articles`               | List completed articles      | Yes            |
| `PATCH` | `/api/articles/:id`           | Set read/unread state        | Yes            |
| `GET`   | `/api/jobs`                   | List active jobs             | Yes            |
| `POST`  | `/api/jobs`                   | Create a job                 | Yes            |
| `GET`   | `/api/jobs/:id`               | Read one job                 | Yes            |
| `GET`   | `/api/jobs/:id/audio`         | Stream normalized MP3        | Yes            |
| `GET`   | `/api/jobs/:id/pdf`           | Generate article PDF         | Yes            |
| `POST`  | `/api/jobs/:id/retry-article` | Reuse transcript and rewrite | Yes            |

`POST /hooks/github` is not handled by the application. Caddy routes it to a
separate, restricted webhook receiver. See `INFRASTRUCTURE.md`.

## 6. Configuration contract

Production application configuration is stored in
`/etc/podcast2article.env`. Values must never be committed or copied into this
document.

| Variable                          | Role                                                            |
| --------------------------------- | --------------------------------------------------------------- |
| `OPENAI_API_KEY`                  | OpenAI API credential                                           |
| `APP_USERS`                       | JSON object with fixed username/password pairs                  |
| `OPENAI_REGION`                   | `global`, `eu`, or `us` API endpoint                            |
| `HOST`                            | Production bind address; currently loopback                     |
| `PORT`                            | Production HTTP port; currently 3000                            |
| `NODE_ENV`                        | Production runtime mode                                         |
| `ARTICLE_MODEL`                   | Article-generation model                                        |
| `TRANSCRIPTION_MODEL`             | Diarized transcription model                                    |
| `MAX_AUDIO_MB`                    | Spotify/RSS source limit                                        |
| `MAX_YOUTUBE_MB`                  | YouTube source limit                                            |
| `MAX_RECORDING_MB`                | Google Drive recording limit                                    |
| `YOUTUBE_METADATA_TIMEOUT_MS`     | Metadata timeout                                                |
| `MEDIA_DOWNLOAD_TIMEOUT_MS`       | Download timeout                                                |
| `FFMPEG_BIN`                      | Optional absolute path overriding the bundled FFmpeg executable |
| `AUDIO_CHUNK_SECONDS`             | Transcript chunk duration                                       |
| `OPENAI_TRANSCRIPTION_TIMEOUT_MS` | Per-chunk API timeout                                           |
| `OPENAI_ARTICLE_TIMEOUT_MS`       | Article API timeout                                             |
| `LOG_STACKS`                      | Enable full stack traces in logs                                |

## 7. Dependency model

Production dependencies:

- Express for HTTP;
- Zod for input validation;
- fast-xml-parser for podcast feeds;
- youtube-dl-exec for YouTube acquisition;
- ffmpeg-static for media processing;
- OpenAI SDK for transcription and article generation;
- PDFKit for PDF export.

Runtime requirements:

- Node.js 22 or newer;
- Python 3.9 or newer for yt-dlp;
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
src/services/resolver.ts   Spotify/RSS/Drive source resolution
src/services/youtube.ts    YouTube metadata and download
src/services/audio.ts      FFmpeg normalization and splitting
src/services/openai.ts     transcription and article generation
src/services/jobs.ts       queue, persistence, lifecycle, recovery
src/services/pdf.ts        PDFKit export
scripts/                   production updater and webhook receiver
deploy/                    systemd, Caddy, cron, and logrotate definitions
```

## 9. Testing and validation

The standard validation command is:

```bash
yarn run check
```

It performs:

1. TypeScript compilation;
2. the Vitest application suite;
3. Node tests for GitHub webhook signature and routing validation.

The production updater refuses to activate a release when dependency install,
build, or tests fail. After activation it also requires the service and local
health endpoint to become healthy, otherwise it restores the previous release.

## 10. Architectural constraints and known limitations

- Designed for a small fixed user group and one globally active processing job.
- Accounts are administrator-managed environment configuration, not a user database.
- Job files are local JSON rather than transactional database records.
- Horizontal scaling is not supported.
- Source availability depends on public third-party endpoints.
- Speaker identity can vary across separate transcription chunks.
- Model output must be reviewed before publication.
- Public availability of a recording does not itself grant republication rights.
- Retained media and transcripts may contain personal or sensitive information.
- Offsite backup is an infrastructure concern and is not currently configured.

## 11. Key architectural decisions

### Native service rather than Docker

The application runs directly under systemd to minimize moving parts and
overhead on the one-GB VPS. Dependencies are sufficiently self-contained that
a container provides limited additional benefit for this deployment.

### PDFKit rather than Chromium

Direct PDF construction avoids a large browser runtime and reduces memory
pressure.

### Normalize once, split with stream copy

One FFmpeg encode creates the retained MP3. Transcript chunking then copies the
encoded stream without another CPU-heavy pass.

### Serial queue

One active job trades throughput for predictable memory and CPU consumption on
the V1 server.

### Immutable releases and external mutable data

Application releases can be switched or rolled back atomically while jobs and
media remain under `/var/lib/podcast2article`.

### Separate webhook receiver

Caddy never executes deployment commands. The receiver authenticates GitHub
and can only create a fixed trigger file. A root-owned systemd service then runs
the hard-coded updater.
