# FFmpeg runtime management

The production installer provisions FFmpeg and ffprobe independently of
application releases. `ffmpeg-static` remains the application dependency and
resolves `FFMPEG_BIN` when configured. Local development retains its bundled
binary by default.

## Pinned installation

`deploy/ffmpeg-release.json` pins BtbN build
`n8.1.2-47-g156bb4d299` from the dated `autobuild-2026-08-27-16-45` release for
Linux x64. The archive SHA-256 is:

```text
5422737149e93e157bd736b699be798e1f6d9ecbd97751a761e2518593004a89
```

This dated artifact has a different archive checksum from the moving `latest`
artifact used during the [original incident](incidents/2026-08-28-fathom-ffmpeg.md).
Both report the same FFmpeg build revision; do not interchange their checksums.
Future updates require reviewing a new dated URL and checksum in the manifest.
An unavailable artifact, unsupported platform, or checksum mismatch fails
installation; there is no fallback to `latest` or an unverified executable.

Run the reviewed infrastructure installer from a repository checkout during an
idle maintenance window:

```bash
sudo deploy/install-infrastructure.sh --check
sudo deploy/install-infrastructure.sh
```

It installs the management scripts and manifest under
`/usr/local/lib/podcast2article/` and tools under
`/opt/podcast2article/tools/<manifest-id>/`. Download staging uses this disk
directory rather than the small `/tmp` tmpfs. SHA-256 is checked before
extraction or execution. A receipt records archive provenance and both executable
hashes; repeated installation verifies those hashes without downloading again.
Existing directories without a valid receipt are never overwritten.

Fresh hosts select the pinned binary using a non-secret `runtime.env` and
`/etc/systemd/system/podcast2article.service.d/90-ffmpeg-override.conf`.
An existing file at that drop-in path is preserved, including the manual
incident override. Other custom FFmpeg configuration should be reviewed before
installation. Credentials are not rewritten, and old binaries are retained.

To install the pinned tools without changing selection or restarting services:

```bash
sudo node /usr/local/lib/podcast2article/ffmpeg-runtime.mjs install /usr/local/lib/podcast2article/ffmpeg-release.json
```

## Activation and rollback

Coordinate maintenance so no new jobs are submitted. `activate` and `rollback`
refuse active or queued stored jobs, and fail closed if job state is unreadable.
They share the updater lock, but do not lock the application's job submission API.

```bash
sudo node /usr/local/lib/podcast2article/ffmpeg-runtime.mjs activate /usr/local/lib/podcast2article/ffmpeg-release.json
sudo node /usr/local/lib/podcast2article/ffmpeg-runtime.mjs rollback
```

Activation saves the previous drop-in content and mode in root-only
`/opt/podcast2article/ffmpeg-selection/`, selects the candidate, and runs the
media test before restarting an existing application. The test verifies the
effective executable matches the requested candidate, detecting conflicting
later overrides. Failed verification restores the prior configuration without
restarting the live app. Failed startup restores the prior selection and
attempts to restart it and verify HTTP health. A fresh host without a current
release defers media verification to its first deployment.

Rollback restores the immediately preceding managed selection (including an
absent drop-in), restarts the service, and verifies HTTP health. It refuses to
overwrite later edits. Repeated activation of the same selection preserves its
rollback history. The tool does not delete binaries, release directories, or
user data. An application release rollback does not change FFmpeg selection.

Until the first managed activation, the existing manual incident mitigation
still uses [its original rollback script](incidents/2026-08-28-fathom-ffmpeg.md#rollback).
Restoring the original bundled executable can restore the crash; HTTP health
alone cannot establish media compatibility. New rollback paths have automated
fixture coverage, not a live production rollback test.

## Media preflight

After installing the updated infrastructure tooling:

```bash
sudo node /usr/local/lib/podcast2article/ffmpeg-runtime.mjs check /opt/podcast2article/current
```

The check runs a temporary systemd service as `podcast2article`, with the
registered application's environment directives and filesystem restrictions.
Systemd reads environment files itself; the tool never sources them as shell
code or prints their contents. Unit-dependent environment specifiers and unsafe
check paths are rejected rather than silently changing their meaning.

It creates two seconds of synthetic AAC in MPEG-TS, remuxes to MP4, invokes the
release's actual audio normalization and chunking functions, then decodes the
resulting chunks. It uses no customer recording, source download, or paid API.
Temporary media and unit files are cleaned up. Failures produce a safe message;
HTTP health remains a separate check.

The updated updater performs this check against each candidate release before
changing `current`. A failure leaves the old process and symlink untouched.
**Install the updated infrastructure explicitly:** merging application code
alone does not replace `/usr/local/sbin/update-podcast2article` or enable this
gate. The installer also checks media before restarting an existing app.

For local verification after compiling:

```bash
npm run build
npm run check:media
```

## Fathom errors

Postprocessing/FFmpeg failures now report `error.fathomProcessingFailed` with
administrator guidance. Explicit download-size refusals map to
`error.fathomDownloadLimit`; recognized authentication failures map to
`error.fathomPrivate`. Other failures retain neutral retry guidance. A missing
output file alone is not evidence of a size limit. The mapper does not attach
raw stderr or subprocess causes containing signed URLs.

The new error messages require deploying the application release. The pinned
runtime tooling and media gate require the infrastructure update described
above; neither was activated on production as part of the repository follow-up.
