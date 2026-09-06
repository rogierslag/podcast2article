# Deployment failure alert

The production updater records its last result in
`/var/lib/podcast2article/deployment-status.json`. Each release already links
`data/` to this shared directory, so a failure remains visible after rollback or
an application restart. The file is replaced atomically and contains only a
`failed` boolean.

Install the updated `scripts/update-production.sh` as
`/usr/local/sbin/update-podcast2article`, the executable used by
`podcast2article-update.service`, when rolling out this feature. An older installed
updater will not write this marker, and earlier failures cannot be reconstructed.
Failures before the updater acquires its lock, forced termination with SIGKILL,
and a fully unavailable application cannot be reported through this alert.

A failed update sets the marker. A successful activation clears it; an update
that finds the deployed commit already current clears it only after checking
service health. Skipping an update because another updater holds the lock leaves
the marker unchanged. An existing failure remains visible while a retry runs.

The articles overview checks `/api/deployment-status` whenever it loads or
refreshes. The endpoint requires authentication and returns no deployment logs or
release details. Authentication-disabled local mode returns `failed: false`.
Missing or malformed status files do not trigger an alert. Public permalink
pages never request deployment status or render the alert, including when their
visitor has an owner session.

## Rollout after merge

First confirm that `/opt/podcast2article/current/.deployed-commit` contains the
merged commit (or a later main commit containing it). Wait for the update service
to finish before replacing its executable. Then install just the reviewed updater
from the active release:

```bash
sudo bash -n /opt/podcast2article/current/scripts/update-production.sh
sudo install -o root -g root -m 0755 \
  /opt/podcast2article/current/scripts/update-production.sh \
  /usr/local/sbin/update-podcast2article.new
sudo mv -f /usr/local/sbin/update-podcast2article.new \
  /usr/local/sbin/update-podcast2article
sudo cmp /opt/podcast2article/current/scripts/update-production.sh \
  /usr/local/sbin/update-podcast2article
sudo systemctl start podcast2article-update.service
sudo cat /var/lib/podcast2article/deployment-status.json
curl -fsS http://127.0.0.1:3000/api/health
```

The reconciliation run checks the already-current release and writes
`{"failed":false}` when healthy. Verify that the application user can read the
marker, that unauthenticated `/api/deployment-status` requests return `401`, and
that the authenticated overview has no alert. Do not manufacture a failed
production deployment to test the warning; use the local fixtures and tests.

The infrastructure installer already copies this updater. Its full installation
also restarts services and provisions other infrastructure, so this script-only
rollout does not require rerunning it or changing systemd, Caddy, or secrets.
