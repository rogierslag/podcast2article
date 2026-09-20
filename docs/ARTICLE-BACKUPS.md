# Article backups to S3

Completed articles can be backed up to a private AWS S3 bucket after successful local persistence.
Set `ARTICLE_BACKUP_BUCKET` to enable the worker.
Without it, backups are disabled and the server logs that state.
Production still needs a configured bucket, credentials and a successful restore drill before this can be considered an operational backup.

## Consistency before cost

Successful local completion requests an immediate backup; uploads are not batched or delayed to save PUT charges.
A receipt is saved only after S3 acknowledges the upload, and identifies exactly the selected payload and destination.
If a response is lost or the receipt cannot be saved, retrying may create another S3 version; preserving recoverability takes priority over avoiding that duplicate PUT.
Uploads are serialized within one worker, and a completion received during an upload schedules a follow-up scan of the latest persisted content.
This is eventual backup of completed local state, not a transaction with S3 or a guarantee that every intermediate revision is retained.

New uploads include a SHA-256 checksum of the compressed bytes so S3 can reject corrupted transfers.
Restore requests checksums and verifies a returned SHA-256 checksum before decompression, schema validation and installation.
Legacy objects without SHA-256 remain restorable through the existing JSON/schema validation path.
See [S3 checksum handling](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html).

Gzip and matching local receipts reduce bytes and repeated PUTs without reducing the selected backup content.
The 15-minute failure cooldown bounds repeated attempts during an outage; healthy uploads still run promptly.
Bucket versioning and a successful production restore drill remain required operational safeguards.

## Scope and delivery

Each object contains schema version `1`, owner, job ID, language, article length, creation and completion timestamps, source URL/type/name/title, optional source image/publication date, and the final article.
The schema explicitly selects fields and strips unknown fields, including inside the article.
No downloaded media, audio chunks, transcript text, prompts, raw model responses, processing logs, API usage, passwords, read state, share tokens or share analytics are included.
Article source references retain their IDs, but there is no transcript or audio in this backup to resolve them against.

New uploads are gzip-compressed JSON with `Content-Type: application/json` and `Content-Encoding: gzip`.
Existing `.json` objects remain readable through the restore fallback.
The new key changes the receipt digest, so the next scan uploads completed local articles once to `.json.gz`, even if their previous `.json` receipt matched.
The worker never deletes legacy objects.

Keys are stable: `<prefix>/v1/users/<username>/<job-id>.json.gz`.
The default prefix is `articles`; an empty prefix is supported.
Prefix components may contain letters, digits, underscores and hyphens.
Owners and job IDs are validated before use.
Different owners with the same job ID have separate keys.

The worker starts after job recovery and scans persisted job files.
Successful completion, including article-only retries and saved shared articles, requests another scan.
Jobs are written by atomic rename, so the worker reads a complete persisted snapshot.
Only jobs whose persisted stage is `complete` are uploaded.
Startup also backfills existing completed articles, including soft-deleted ones.

Successful uploads leave a local SHA-256 receipt under `data/article-backups/<username>/<job-id>.sha256`.
It covers the destination and selected payload.
Unchanged articles cause no S3 request, even after restart or read-state changes.
Revised final content replaces the same key.
A destination change causes another upload.
A crash after upload but before receipt persistence can repeat the PUT; the key remains the same.
With bucket versioning enabled, that repeat can create an additional identical version.

Local completed jobs are the durable retry source.
The worker scans every 60 seconds, but the first upload failure stops the scan and pauses all uploads for 15 minutes.
Completion requests and timer scans cannot bypass that cooldown; another failure starts a new 15-minute pause.
The cooldown is in memory, so restarting the server or starting a new backfill process retries immediately.
Uploads run sequentially, with one SDK attempt per upload and a 30-second request deadline.
Scan-level filesystem failures and failures to save an upload receipt also trigger the cooldown; malformed individual jobs are still skipped.
A long queue or outage can delay backups; there is no zero-loss guarantee between local completion and successful upload.
Failure never changes the completed job into a failed generation.
Inspect `journalctl -u podcast2article` for `Article backup uploaded`, `Article backup ... failed`, and disabled-backup messages.
Malformed files are logged and skipped so other articles can still upload.

The receipt records a successful upload, not ongoing remote existence.
If objects are removed externally, stop the server, remove the relevant local receipts and run backfill again.
Do not run multiple application or backfill processes against the same data directory simultaneously.

## Bucket and deployment configuration

Use a dedicated general-purpose AWS S3 bucket in the chosen region.
Before enabling uploads, configure:

- all four S3 Block Public Access settings at bucket level;
- Object Ownership **Bucket owner enforced**, disabling ACLs;
- default SSE-S3 encryption and S3 Versioning;
- a bucket policy denying requests where `aws:SecureTransport` is `false`;
- no public or cross-account grants, and least-privilege IAM access.

The uploader uses HTTPS and explicitly requests `AES256` (SSE-S3), without an ACL.
Bucket privacy is an operator prerequisite: the application does not create buckets or change bucket policies.
SSE-S3 has no separate key-management charge.
This implementation targets AWS S3; custom S3-compatible endpoints and SSE-KMS are not configured by this feature.

Give the application credential only `s3:PutObject` on `arn:aws:s3:::BUCKET/articles/v1/users/*` (adjust for the selected prefix).
It does not need list, read, ACL, bucket-administration or delete permission.
Use a separate operator credential with `s3:GetObject` for restore and `s3:ListBucket` so a missing gzip key returns `NoSuchKey` and allows the legacy fallback.
Without list permission, S3 can return `AccessDenied` for a missing key; the restore command deliberately does not treat that as permission to fall back.
See [GetObject permissions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).
User paths preserve application isolation, but the server's single backup credential necessarily writes all accounts; do not give it to users.

Add these values to `/etc/podcast2article.env`, preserving existing secrets:

```dotenv
ARTICLE_BACKUP_BUCKET=your-private-backup-bucket
ARTICLE_BACKUP_REGION=eu-west-1
ARTICLE_BACKUP_PREFIX=articles
AWS_ACCESS_KEY_ID=<backup-writer-access-key>
AWS_SECRET_ACCESS_KEY=<backup-writer-secret>
# AWS_SESSION_TOKEN=<only-for-temporary-credentials>
```

The AWS SDK's standard credential chain also supports an instance role.
Never commit credentials.
Keep the environment file readable only by its existing privileged owner/service configuration.
Restart the application once jobs are idle.
No new service or cron installation is needed.
The service's existing writable data directory also holds upload receipts.

## Explicit backfill

Build with `yarn run build`, then run from the repository/release root so `data/` resolves correctly:

```bash
yarn run backup:articles backfill
```

The command loads `.env` if present and otherwise uses its process environment.
It uploads completed articles, skips matching receipts, prints a failure count and exits nonzero if any upload or scan fails.
An upload failure stops the backfill before attempting the remaining articles.
Wait 15 minutes before rerunning to recover failed uploads.
Keep the application stopped for an explicit production backfill; normal startup already runs the same scan.

On the systemd host, use the service environment without copying secrets to the release or shell history:

```bash
sudo systemctl stop podcast2article
sudo systemd-run --wait --pipe --collect \
  --property=User=podcast2article --property=Group=podcast2article \
  --property=WorkingDirectory=/opt/podcast2article/current \
  --property=EnvironmentFile=/etc/podcast2article.env \
  /usr/bin/node dist/commands/article-backups.js backfill
sudo systemctl start podcast2article
```

Inspect the output and exit status before restarting.
Confirm at least one object in S3 and complete the restore drill below with an operator read credential.

## Migrating existing objects

Deploy the gzip-capable writer and restore command before migrating production backups.
Migration replacements must use `.json.gz` keys, not gzip bytes stored under `.json` keys.
A separate operator migration must inventory legacy objects and versions, read each original, write its compressed replacement, then download and verify that decompression reproduces the original bytes before deleting that original version.
Preserve historical revisions and any newer `.json.gz` content; a legacy object must not overwrite a newer article.
Do not delete an original whose replacement cannot be verified.
Bucket versioning requires explicit version deletion to remove the uncompressed bytes; a delete marker alone does not remove them.
This requires operator list, read, write and version-delete permissions, beyond the application's write-only credential.
The backfill command only uploads completed local articles; it does not migrate remote-only articles or remove legacy objects.

## Retention and deletion

The application does not expire or delete remote backups.
Local soft deletion hides an article in the application but retains its backup; deleted completed articles are included in backfill too.
Permanent local removal before the first successful upload loses the retry source.
Once uploaded, removing local files does not remove the S3 object.

Suggested bucket policy: retain current versions indefinitely, expire noncurrent versions after 30 days, and abort incomplete multipart uploads after seven days.
This is a proposed retention policy, not something the application applies.
Set it explicitly with the bucket administrator.
Avoid transitioning these small JSON objects to infrequent-access or archive classes without checking minimum billable sizes, minimum duration and retrieval costs.

For an actual erasure request, remove the local job and its receipt with the server stopped, then have a privileged operator remove **all versions** of its `.json.gz` key and any legacy `.json` key.
A delete marker alone does not erase retained versions.
The backup writer should not have deletion rights.
S3 Versioning is recovery protection, not immutable storage; Object Lock would require a separate retention decision.

## Restore without generation

Restore into a clean checkout/data directory first.
Configure the same bucket, region and prefix, and use a separate credential permitted to read that key:

```bash
yarn install --frozen-lockfile
yarn run build
yarn run backup:articles restore owner aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
```

The command first fetches the `.json.gz` object and falls back to `.json` only when S3 returns `NoSuchKey`.
Access, checksum and decoding errors fail visibly rather than restoring a potentially stale legacy copy.
It fetches the current object, decompresses gzip when present (while accepting legacy plain JSON), validates schema version, owner and job ID, then atomically creates `data/users/owner/jobs/<job-id>.json` with mode `0600`.
It refuses to overwrite an existing job or change ownership.
For an older S3 version, retrieve the selected version using an operator tool and validate it with `restoreArticleBackup` before installation; the CLI restores only the current version.

Start the application with the restored owner configured in `APP_USERS`, and verify that the article appears, its full text is readable, and PDF export works.
No generation runs because the restored job is already complete.
Timestamp playback, transcript search, article-only retry, previous public permalinks, reading history and usage accounting cannot be recovered from this article-only format.
Source links still identify the original recording.
This is not a full account, configuration or media backup.

For production recovery, stop the application first and run the compiled restore command from the active release under the service user, using the same systemd-run pattern as backfill but with an operator environment file containing the temporary read credential.
Restore only a missing job, then restart and verify it.
Preserve existing job data separately when investigating corruption.
Do not replace a live job or use this restore to reset account spending history.

Record the tested object, restore date and outcome in your operational records.
A unit-tested restore path is not proof of a successful production restore.

## Monthly cost estimate

Planning assumptions: AWS S3 Standard in Ireland (`eu-west-1`), one 100 KiB stored object per article, one PUT per new article, no reads during normal operation, and no chargeable noncurrent versions.
Article sizes, compression ratios and production volume have not been measured.
The estimate uses stored bytes after compression; gzip reduces storage and transfer sizes, but not the number of PUT requests.
AWS's regional price list checked on 20 September 2026 gives USD 0.023 per GB-month (first 50 TB), USD 0.005 per 1,000 PUTs, and USD 0.0004 per 1,000 GETs.
For S3 storage billing, the GB calculation uses 2^30 bytes.

| Retained articles | New articles/month | Approximate storage | Monthly storage + PUTs |
| ----------------- | ------------------ | ------------------- | ---------------------- |
| 1,000             | 100                | 0.095 GiB           | USD 0.003              |
| 10,000            | 1,000              | 0.954 GiB           | USD 0.027              |
| 100,000           | 10,000             | 9.537 GiB           | USD 0.269              |

Formula: `retained bytes / 2^30 × 0.023 + monthly PUTs / 1000 × 0.005`.
For 1,000 new articles each month starting empty, month 12 ends with 12,000 articles: about USD 0.031/month at that retained volume.
This is an end-of-month run rate; actual storage billing follows time stored.
A one-time 10,000-article backfill adds about USD 0.05 in PUT charges.

Budget USD 1/month for modest article-only use; this is a planning allowance, not a provider minimum or a capped bill.
Retained versions, duplicate PUTs after ambiguous failures, larger articles, inventory/logging, restore egress and taxes can add costs.
Existing free allowances are excluded.
SSE-S3 has no additional encryption fee; no KMS key, replication or separate backup compute is assumed.
Confirm the actual bucket region and measure serialized article sizes after setup.

Sources: [AWS S3 pricing](https://aws.amazon.com/s3/pricing/), [AWS Ireland regional price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/eu-west-1/index.json), [SSE-S3 encryption](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingServerSideEncryption.html), [Object Ownership](https://docs.aws.amazon.com/AmazonS3/latest/userguide/about-object-ownership.html).
