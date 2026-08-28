# Fathom download failure: production FFmpeg crash

Date: 2026-08-28. Times below use Europe/Amsterdam (UTC+02:00).

## Outcome

A separately installed FFmpeg resolved the observed production failure without
application code changes. A subsequent user-started job completed at 14:52:58;
its article was saved and its playback audio existed. The original executable
remains installed. The mitigation was initially manual; the repository follow-up
below makes provisioning reproducible without replacing that live selection.

## What happened

1. Fathom metadata resolution succeeded at 14:11:38 for a recording of about
   26 minutes, and the job entered `downloading`.
2. At 14:14:39 the job failed with `error.fathomDownloadFailed`. The English UI
   suggested checking access and the download limit.
3. A small sample from the same source succeeded locally but reproduced a
   postprocessing failure on production. yt-dlp's diagnostic output showed
   FFmpeg remuxing the downloaded MPEG-TS data into MP4.
4. Production kernel logs recorded FFmpeg segmentation faults at the original
   failure time and during the reproductions. The observed crashing binary was
   `7.0.2-static`; yt-dlp reported `2026.08.19`.
5. A replacement passed sample and full-recording media tests before activation.
   The user then started a new job at 14:38:51; download, transcription, and
   article generation completed successfully at 14:52:58.

The confirmed failure mechanism was a native FFmpeg crash during yt-dlp
postprocessing. The Fathom error mapper intentionally hides downloader stderr
because it can contain signed URLs, but its generic fallback obscured the
processing failure as a possible access or size problem.

The precise defect inside FFmpeg, and whether this build fails on other inputs
or platforms, were not established. An early suspicion about the `source.media`
filename was not confirmed. The replacement worked with the same target path
and application pipeline. Do not describe this as an identified upstream bug,
a permissions change, or a download-limit increase.

## Installed mitigation

| Item                        | Installed value                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| Build                       | BtbN FFmpeg `n8.1.2-47-g156bb4d299-20260827`                                                |
| Tool directory              | `/opt/podcast2article/tools/ffmpeg-20260828/`                                               |
| Executables                 | `bin/ffmpeg` and `bin/ffprobe` inside the tool directory                                    |
| Non-secret environment file | `runtime.env` inside the tool directory                                                     |
| Setting                     | `FFMPEG_BIN=/opt/podcast2article/tools/ffmpeg-20260828/bin/ffmpeg`                          |
| systemd drop-in             | `/etc/systemd/system/podcast2article.service.d/90-ffmpeg-override.conf`                     |
| Recovery records            | `README.md`, `verification.txt`, `activate.sh`, and `rollback.sh` inside the tool directory |

The downloaded archive was
`ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz` from
[BtbN's FFmpeg builds](https://github.com/BtbN/FFmpeg-Builds/releases).
Its verified SHA-256 was:

```text
e82efe1805aa1cb4b1805986f71763c07bd2543eed129b182fdaed4b94f50318
```

The download used a moving `latest` release URL. This checksum records the
specific archive actually installed, not whatever that URL serves later. Future
provisioning must identify and verify its intended artifact explicitly.

The drop-in appends the following after the existing application environment
file:

```ini
[Service]
EnvironmentFile=/opt/podcast2article/tools/ffmpeg-20260828/runtime.env
```

The tool directory is root-owned; the application cannot modify its binaries or
configuration. Application code, bundled binaries, system packages, credentials,
and existing user data were not changed by the mitigation. Activation checked
that no jobs were active or queued, then restarted the service. The override
persists across application deployments and release rollbacks.

## Verification

- The sample passed download postprocessing, MP3 normalization, and chunking.
- The full source passed the deployed `downloadFathomRecording`, `normalizeAudio`,
  and `splitAudio` functions under a temporary systemd service running as the
  application user with filesystem and privilege restrictions. Source size:
  200,987,735 bytes; MP3 size: 9,325,948 bytes; output: six chunks. The test exited
  successfully after 3 minutes 13 seconds.
- Temporary test media was removed. These verification runs did not invoke
  transcription or article generation; the later user-started job did.
- After activation, the running application process selected the replacement.
  Public health returned `{"ok":true}`, login returned HTTP 200, and
  unauthenticated article/job collection requests still returned HTTP 401.
- The subsequent real job reached `complete`, 100%, with no error; saved article
  sections and the playback file were verified without exposing their content.
- The rollback script passed shell syntax validation. Live rollback was not
  exercised; restoring the original binary can reintroduce this Fathom failure.

## Rollback

Coordinate with other maintenance and wait for active jobs to finish. On the
affected server, run:

```bash
sudo /opt/podcast2article/tools/ffmpeg-20260828/rollback.sh
```

The script compares the active drop-in with its saved copy, refuses to overwrite
later edits, moves the drop-in out of systemd's configuration directory, reloads
systemd, restarts the app, and checks HTTP health. It does not reinstall anything
or delete user data. Without another override, the app returns to its bundled
FFmpeg. A healthy HTTP endpoint does not imply the original Fathom crash is fixed.

## Repository follow-up

The follow-up adds a checksum-pinned FFmpeg/ffprobe manifest, guarded selection
and rollback, a real media preflight before release activation, and localized
Fathom processing errors distinct from access and size failures. See the
[runtime runbook](../FFMPEG.md) for commands and rollout requirements.

The synthetic Linux test reproduced the crash with the original bundled binary
and passed with the dated, pinned replacement archive. Installation and repeat
verification were tested in an isolated directory. The preflight also passed
with the existing production service environment without restarting the app.
Automated tests cover checksum failures, configuration restoration, rollback,
active-job refusal, and private error handling. Live activation/rollback of the
new management tool was not exercised.

These repository changes were not installed into the live production runtime
during the follow-up. Source share tokens, job IDs, recording content, and
credentials are deliberately omitted.
