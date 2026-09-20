# Deployment freshness and failure warning

`GET /api/health` is public and always returns HTTP 200 with `ok: true` while the application can serve the request.
Deployment freshness never changes that availability signal, including during the updater's activation check.
Responses have `Cache-Control: no-store` and a separate `deployment` object:

```json
{
  "ok": true,
  "deployment": {
    "status": "imminent",
    "runningCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "targetCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "lastCheckedAt": "2026-09-19T15:00:00.000Z"
  }
}
```

The running commit is resolved once at application startup using the existing build identity (`GIT_SHA`/`GITHUB_SHA`, then `.deployed-commit`, then local Git).
It is not read from the mutable `current` symlink on each request.
The target and last-check time come from locally persisted updater information; health requests never contact GitHub.
Unknown or invalid identities/timestamps are `null`.
No logs, account details, credentials, filesystem paths, or private failure flag are returned.

## Status rules and timing

- `up_to_date`: running and latest known target commits match, and the successful remote check is no more than 45 minutes old.
- `imminent`: commits differ, the updater has acquired its lock and resolved the remote target, no failure remains recorded, and less than 30 minutes have elapsed since that target was first observed.
  A webhook acknowledgement alone never writes freshness state and cannot establish progress.
- `delayed`: commits differ and a failure is recorded, the 30-minute window has elapsed, or the updater completed but the serving process still has another commit.
  A retry preserves the original target deadline and failure flag until success, so repeated failures cannot restart an endless imminent window.
- `unknown`: required information is missing, malformed, future-dated, or more than 45 minutes old, or no active deployment can be established.
  Staleness takes precedence over all other states, even a previously matching release.

The 30-minute deployment window is a UI warning threshold, separate from systemd's 45-minute updater timeout and the 15-minute drain limit.
A long-running deployment can therefore appear delayed before systemd times it out.
The freshness window remains 45 minutes; without a new successful remote check, the status then becomes unknown.
Cron now starts the updater every five minutes, including when webhooks are missed.
Thus the endpoint describes the **latest known** main commit, not a live GitHub comparison: a new push can remain undiscovered until the next successful check.
A long-running update holds the existing lock; skipped invocations leave its timestamps unchanged.
No heartbeat extends the deadline.
SIGKILL or power loss may bypass the failure trap, but the original deadline still changes an interrupted deployment to delayed, then unknown if no new check succeeds.
Failed remote checks preserve the last successful check timestamp.

## Persistence and the private warning

The lock-holding updater atomically replaces `/var/lib/podcast2article/deployment-status.json`, linked into every release's `data/` directory.
It contains `failed`, `phase` (`checking`, `deploying`, `idle`, `failed`), `targetCommit`, `targetObservedAt`, and `lastCheckedAt`.
Persisted times are Unix milliseconds; the public last-check field is ISO 8601.
Python 3.11+, already required by the host installer, writes and replaces the JSON safely.

A failed build or activation sets `failed: true`.
Rollback retains the target commit, while the restarted application reports its own running commit.
A successful activation clears the flag; an already-current reconciliation clears it only after checking service and HTTP health.
A retry retains an existing failure warning.
Lock contention leaves all state unchanged.

The authenticated `/api/deployment-status` endpoint and articles overview retain their existing failure-only behavior.
Public permalink pages never request or show that warning.
Authentication-disabled local mode returns `failed: false`.
Legacy boolean-only markers still support the warning but produce unknown freshness until the new updater runs.
Missing or unreadable markers cannot prove a failure.
A fully unavailable application cannot report either signal.

## Host rollout after merge

An application push alone does not replace the host updater or cron configuration.
Wait for the update service to finish, then install both reviewed files from the release containing this change.
The full infrastructure installer also installs them, but is unnecessary for this focused rollout:

```bash
sudo bash -n /opt/podcast2article/current/scripts/update-production.sh
sudo install -o root -g root -m 0755 \
  /opt/podcast2article/current/scripts/update-production.sh \
  /usr/local/sbin/update-podcast2article.new
sudo mv -f /usr/local/sbin/update-podcast2article.new \
  /usr/local/sbin/update-podcast2article
sudo install -o root -g root -m 0644 \
  /opt/podcast2article/current/deploy/podcast2article-update.cron \
  /etc/cron.d/podcast2article-update
sudo cmp /opt/podcast2article/current/scripts/update-production.sh \
  /usr/local/sbin/update-podcast2article
sudo systemctl start podcast2article-update.service
sudo cat /var/lib/podcast2article/deployment-status.json
curl -fsS http://127.0.0.1:3000/api/health
```

Verify that the running and target commits match, the check timestamp is recent, and the application user can read the marker.
Verify that unauthenticated `/api/deployment-status` requests still return `401` and the authenticated overview has no warning after success.
Do not manufacture a failed production deployment; use the local transition and updater tests.
This PR does not install host files or claim production freshness has been verified.
