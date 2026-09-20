# Deployment recovery

Deployments pause admission of new paid HTTP requests, wait for active transcription requests and article submissions to persist their results, and then restart the application.
Queued recordings remain accepted and resume afterwards.
There is no separate worker process or distributed queue.

## Drain protocol

After building and validating the new release, `scripts/update-production.sh` creates `data/deployment-drain.json` with a unique deployment ID.
The running application checks this file every 250 milliseconds and closes admission before writing a matching `deployment-drain-status.json` acknowledgement.
The active count includes each transcription HTTP attempt through chunk-result and accounting persistence, and each article submission through response-ID and accounting persistence.
Provider retries must acquire admission again, so a retry waiting for admission does not delay deployment.

The updater waits for a matching acknowledgement with zero active requests before changing the release symlink or restarting systemd.
It gives the drain 15 minutes; a timeout fails deployment and leaves the current release running.
The updater's exit handler removes only its own pause marker on success or failure, including after rollback.
The new application reads the marker before recovering jobs and remains paused until that cleanup finishes.
The update service allows 45 minutes for build, verification, drain, and activation.

A forcibly killed updater can leave a marker behind.
After confirming that no deployment is running, remove `data/deployment-drain.json` to resume admission; do not fabricate a drained acknowledgement.
A missing acknowledgement or malformed marker fails closed.
The protocol uses local files and exposes no HTTP deployment control endpoint.

## Transcription checkpoints

Completed source downloads and playback audio are published by rename from temporary files.
Playback audio is retained in the existing per-user media directory.
The job workspace contains a versioned chunk manifest with the original model, language, chunk length, and ordered filenames.
Each complete chunk response is atomically written before the request releases its drain reservation.
An empty but valid transcript response can represent silence and is reusable.
Temporary JSON files do not establish completion, and corrupt final artifacts stop processing rather than silently starting new paid work.

Recovery reuses saved chunk responses and assembles source IDs and timestamp offsets in manifest order.
Changing transcription configuration does not reinterpret an existing manifest.
Missing chunk audio can be rebuilt from retained playback with the saved chunk length.
If both required chunk audio and its original playback are missing, the job fails rather than mixing new source media with previously paid results.
A complete transcript from an older job bypasses media preparation and transcription, even without a manifest or retained playback.

Intermediates are removed after the complete transcript is stored; the playback file remains available to the reader.
Interrupted or failed transcription retains its workspace for recovery and investigation.
Three processing slots bound active media preparation and transcription; article generation has three separate slots.
Failed workspaces require operator review before removal and are not a hard total-disk quota.
Downloads and FFmpeg still share the existing serialized media slot, and chunks within a job remain sequential.
This change does not implement the broader independent-stage scheduler proposed in issue #54.

## Background articles

Article requests use the Responses API with `background: true` and `store: true`.
The returned response ID, endpoint, and request accounting identity are saved in the job before submission releases its drain reservation.
Startup resumes retrieval of that response instead of submitting another generation.
The original response endpoint must match the configured endpoint; an endpoint change requires operator investigation.

The application retrieves outstanding responses immediately on recovery and polls every five seconds while waiting.
Transient retrieval failures retry without submitting another generation.
Completed answers and usage are persisted before JSON parsing and source validation.
Recovery can reconcile accounting from that saved response if the process stopped between saving the answer and updating the usage ledger.
Owner-requested article regeneration explicitly starts a new response and retains the prior attempt ledger.

Optionally set `OPENAI_WEBHOOK_SECRET` and configure the OpenAI project to send response completion, failure, cancellation, and incomplete events to `/hooks/openai` on the public application origin.
The endpoint verifies the signature against the raw request body and only wakes an existing response poller.
Repeated or missed events are harmless: polling is authoritative and result persistence uses the original request identity.
Without a signing secret the route returns `404`, and periodic polling still works.
The route does not grant access to owner APIs or accept job content from a webhook.

Background processing and stored-response retention must be supported by the configured provider and project data policy.
Provider retention is finite; this mechanism is not an indefinite remote backup.
The article HTTP timeout applies to submission; individual retrieval calls have a 30-second timeout.

## First rollout and limitations

An older running release cannot acknowledge this drain protocol.
The new updater refuses automatic activation in that case.
For the first rollout, apply the reviewed infrastructure updates during an idle maintenance window, wait until processing is idle again, stop `podcast2article.service`, and run the updater while the application remains stopped.
The updater skips draining a stopped service, activates the new release, and starts it normally.
Verify service health and the installed updater and systemd unit before returning to unattended deployment.
Infrastructure installation and manual service restarts are separate operator actions; they do not automatically use this deployment handshake.

Direct `SIGINT` or `SIGTERM` still aborts active HTTP connections and persists resumable job state within the application's 15-second shutdown deadline and systemd's 20-second deadline.
Use the updater for a drained deployment.
Aborting an article polling connection does not cancel its remote background response.

A host crash, disk failure, or interruption before a received response is durably published can still lose paid work.
An ambiguous article submission can also lack a saved provider ID.
Unknown costs remain unknown, and the implementation does not guarantee exactly-once billing.
All automated recovery tests use mocked paid APIs.
