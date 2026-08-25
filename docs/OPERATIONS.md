# Podcast2Article Operations

Document version: 2026-08-23

This document is the production operations template for Podcast2Article.
Replace documentation addresses and example identifiers with the values for the
actual host. Re-verify commands and paths after material infrastructure changes.

Application internals are documented in `../ARCHITECTURE.md`.

## 1. Production summary

| Item              | Value                                                          |
| ----------------- | -------------------------------------------------------------- |
| Provider          | TransIP or another VPS provider                                |
| VPS class         | 1 vCPU and 1 GiB RAM minimum                                   |
| Hostname          | `production.example.nl`                                        |
| Operating system  | Ubuntu LTS, x86-64                                             |
| CPU               | 1 shared vCPU                                                  |
| RAM               | 1 GiB minimum; 2 GiB preferred                                 |
| Swap              | 2 GiB `/swapfile`                                              |
| Root disk         | 20 GiB minimum; size for retained media                        |
| Public IPv4       | `192.0.2.10`                                                   |
| Public IPv6       | `2001:db8::10`                                                 |
| Public URL        | `https://production.example.nl`                                |
| Application port  | `127.0.0.1:3000`                                               |
| Webhook port      | `127.0.0.1:9000`                                               |
| Reverse proxy     | Caddy 2.6.2                                                    |
| Runtime           | Node.js 22+, Python 3.9+                                       |
| Deployment source | `https://github.com/rogierslag/podcast2article`, branch `main` |

At the time of verification, disk use was about 6.4 GiB of 96 GiB and the
application, webhook receiver, Caddy, SSH, and system services were healthy.

## 2. Network topology

```text
Internet
  |
  +-- TCP 22 ------------------------------> OpenSSH
  |
  +-- TCP 80/443, IPv4 and IPv6 ----------> Caddy
                                                |
                                                +-- normal request
                                                |      -> 127.0.0.1:3000
                                                |         Podcast2Article
                                                |
                                                +-- POST /hooks/github
                                                       -> 127.0.0.1:9000
                                                          webhook receiver
```

Only SSH, HTTP, and HTTPS listen publicly. The application, webhook receiver,
Caddy admin endpoint, and local resolver listen on loopback.

## 3. DNS

Example TransIP authoritative DNS records:

```dns
production.example.nl.  A     192.0.2.10
production.example.nl.  AAAA  2001:db8::10
```

Verify directly against TransIP:

```bash
dig @ns0.transip.nl production.example.nl A
dig @ns0.transip.nl production.example.nl AAAA
```

The IPv6 address is derived from the VPS network prefix and interface. Recheck
both DNS records after rebuilding or replacing the VPS.

## 4. Firewall and exposed ports

UFW is enabled with:

```text
default incoming: deny
default outgoing: allow
22/tcp:  allow from anywhere, IPv4 and IPv6
80/tcp:  allow from anywhere, IPv4 and IPv6
443/tcp: allow from anywhere, IPv4 and IPv6
```

Useful checks:

```bash
sudo ufw status verbose
sudo ss -lntp
```

Allow the same ports in the provider control-plane firewall. Confirm both the
provider firewall and host firewall after every networking change.

Port 3000 and port 9000 must never be exposed publicly.

## 5. TLS and reverse proxy

Caddy owns public HTTP and HTTPS. Its configuration is:

```text
/etc/caddy/Caddyfile
```

Routing:

```text
/hooks/github -> 127.0.0.1:9000
all other paths -> 127.0.0.1:3000
```

Caddy:

- redirects HTTP to HTTPS;
- obtains certificates through ACME/Let's Encrypt;
- renews certificates automatically;
- serves the same certificate over IPv4 and IPv6;
- applies gzip or Zstandard response encoding where appropriate.

Certificate state is managed by Caddy under:

```text
/var/lib/caddy/.local/share/caddy/
```

Do not manually replace or renew Caddy-managed certificates.

Validate and reload Caddy safely:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy
```

External verification:

```bash
curl -I http://production.example.nl/
curl -I https://production.example.nl/login
openssl s_client -connect production.example.nl:443 \
  -servername production.example.nl </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

## 6. Accounts and privilege boundaries

### `admin`

- Human administration account.
- UID 1000.
- SSH key authentication.
- Passwordless sudo was available during provisioning.

### `podcast2article`

- System account for the application.
- No interactive shell.
- Cannot use sudo.
- Reads `/etc/podcast2article.env` through its group.
- Writes only to `/var/lib/podcast2article` under systemd policy.

### `podcast2article-webhook`

- System account for the webhook receiver.
- No interactive shell.
- Cannot use sudo.
- Reads only its webhook environment file.
- Can write only to `/run/podcast2article-webhook`.
- Network access is restricted to localhost by systemd.

The root-owned updater is not invoked directly by Caddy or the webhook process.
It is started by a fixed systemd path/service pair.

## 7. SSH security

The hardening drop-in is:

```text
/etc/ssh/sshd_config.d/99-podcast2article.conf
```

Effective intended policy:

```text
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
```

Before changing SSH configuration:

1. keep the current SSH session open;
2. validate with `sudo sshd -t`;
3. reload rather than restart SSH;
4. open a second session and verify access;
5. only then close the original session.

## 8. Filesystem layout

```text
/opt/podcast2article/
  current -> releases/<active-release>
  releases/
    <timestamp>-<commit>/
      dist/
      public/
      node_modules/
      data -> /var/lib/podcast2article
      .deployed-commit

/var/lib/podcast2article/
  users/
    <username>/
      jobs/             persistent job JSON
      media/            persistent normalized MP3 files
      work/             temporary per-job workspace

/var/cache/podcast2article-yarn/
                        dependency cache used during release validation

/etc/podcast2article.env
                        application configuration and secrets

/etc/podcast2article-webhook.env
                        webhook secret and local listener configuration

/usr/local/sbin/update-podcast2article
                        root-owned guarded updater

/usr/local/lib/podcast2article/github-webhook-server.mjs
                        root-owned webhook receiver code

/var/log/podcast2article-update.log
                        deployment validation and update log
```

Release directories and executable code are root-owned and read-only to the
application account. Persistent application data is owned by
`podcast2article:podcast2article` with mode 0750 on the data root.

The updater retains the three newest release directories after a successful
deployment.

## 9. systemd units

### `podcast2article.service`

Runs the main application:

```text
WorkingDirectory=/opt/podcast2article/current
ExecStart=/usr/bin/node --max-old-space-size=384 dist/server.js
EnvironmentFile=/etc/podcast2article.env
```

Behavior:

- enabled at boot;
- restarts after failure;
- waits up to 20 seconds for graceful shutdown;
- has no Linux capabilities;
- receives a private temporary directory and devices;
- has a read-only system view except for `/var/lib/podcast2article`;
- cannot read home directories.

### `podcast2article-webhook.service`

Runs the signed GitHub webhook receiver on `127.0.0.1:9000`.

The receiver:

- accepts only `POST /hooks/github`;
- limits the raw request body to 1 MiB;
- verifies `X-Hub-Signature-256` before parsing JSON;
- accepts only `push` events;
- accepts only repository `rogierslag/podcast2article`;
- accepts only `refs/heads/main`;
- requires a GitHub delivery ID;
- writes one fixed trigger file after successful validation;
- cannot run system commands or access the deployment script.

### `podcast2article-update.path`

Watches:

```text
/run/podcast2article-webhook/trigger
```

When the file exists, it starts `podcast2article-update.service`.

### `podcast2article-update.service`

Runs the root-owned updater as a low-priority one-shot service. It removes the
fixed trigger file before starting and has a 30-minute timeout.

### Common service commands

```bash
sudo systemctl status podcast2article
sudo systemctl status podcast2article-webhook
sudo systemctl status podcast2article-update.path
sudo systemctl status podcast2article-update.service
sudo systemctl status caddy

sudo systemctl restart podcast2article
sudo systemctl restart podcast2article-webhook
```

## 10. GitHub webhook

Repository:

```text
https://github.com/rogierslag/podcast2article
```

Configured webhook:

```text
ID:       <webhook-id>
URL:      https://production.example.nl/hooks/github
Events:   push
Active:   yes
SSL:      verification enabled
```

The GitHub ping and built-in test push both returned HTTP 202 during
provisioning.

The webhook secret exists in two places by design:

1. GitHub's encrypted webhook configuration;
2. `/etc/podcast2article-webhook.env` on the VPS.

The plaintext value must never be copied into documentation, Git, chat, shell
history, or logs.

Inspect recent GitHub deliveries from an authenticated workstation:

```bash
WEBHOOK_ID='replace-with-webhook-id'
gh api "repos/rogierslag/podcast2article/hooks/${WEBHOOK_ID}/deliveries" \
  --jq '.[:10] | map({event,status,status_code,delivered_at,duration})'
```

Inspect receiver logs:

```bash
sudo journalctl -u podcast2article-webhook --since today
```

## 11. Automatic deployment

The canonical deployment source is the `main` branch on GitHub.

### Webhook path

Every valid push to `main` triggers an immediate update attempt.

### Daily reconciliation

Cron starts the same systemd update service every day at 04:00 in the server's
`Europe/Amsterdam` timezone:

```text
/etc/cron.d/podcast2article-update
```

The daily check recovers from a missed or delayed webhook.

### Update algorithm

`/usr/local/sbin/update-podcast2article`:

1. takes `/run/lock/podcast2article-update.lock` with `flock`;
2. reads the current GitHub `main` commit;
3. exits without restarting when already current;
4. creates an isolated build directory under `/var/tmp`;
5. fetches the exact commit, detached;
6. installs locked development dependencies;
7. runs the TypeScript build and complete test suite;
8. creates a new immutable release directory;
9. installs locked production dependencies;
10. links `data` to `/var/lib/podcast2article`;
11. atomically changes `/opt/podcast2article/current`;
12. restarts the application;
13. waits up to 30 seconds for systemd and `/api/health`;
14. keeps the new release on success;
15. restores the previous symlink and restarts on failure;
16. retains the three newest successful release directories.

The application continues serving from the old release while a new release is
being downloaded, built, and tested. Downtime is limited to the final graceful
restart.

### Logs

```bash
sudo tail -f /var/log/podcast2article-update.log
sudo journalctl -u podcast2article-update.service
```

Log rotation is configured weekly with eight compressed rotations:

```text
/etc/logrotate.d/podcast2article-update
```

### Manual safe trigger

To run the same validation and update mechanism immediately:

```bash
sudo systemctl start podcast2article-update.service
sudo systemctl status podcast2article-update.service
sudo tail -n 100 /var/log/podcast2article-update.log
```

Do not run two ad-hoc copies of the update script. The lock prevents overlap,
but systemd is the canonical invocation path.

## 12. Manual rollback

Automatic rollback occurs when a newly activated application fails its local
health check.

For a manual rollback:

1. list available releases;
2. identify a known-good release;
3. atomically replace the `current` symlink;
4. restart the application;
5. verify local health and public login.

```bash
ls -la /opt/podcast2article/releases
readlink -f /opt/podcast2article/current

sudo ln -s /opt/podcast2article/releases/<known-good-release> \
  /opt/podcast2article/.manual-rollback
sudo mv -Tf /opt/podcast2article/.manual-rollback \
  /opt/podcast2article/current
sudo systemctl restart podcast2article

curl -fsS http://127.0.0.1:3000/api/health
curl -I https://production.example.nl/login
```

Use an exact release name. Never recursively delete `/opt/podcast2article` or
`/var/lib/podcast2article` during rollback.

## 13. Secrets and rotation

### Application environment

```text
/etc/podcast2article.env
owner: root
group: podcast2article
mode: 0640
```

It contains the OpenAI API key, fixed user accounts, model selection, limits,
timeouts, region, and bind configuration. `APP_USERS` is a JSON object with a
unique password of at least 16 characters for every username.

To display the account configuration when administratively necessary:

```bash
sudo sed -n 's/^APP_USERS=//p' /etc/podcast2article.env
```

Avoid running this while screen sharing or recording a terminal.

After changing application configuration:

```bash
sudo systemctl restart podcast2article
sudo systemctl status podcast2article
```

Changing `APP_USERS` immediately invalidates all old cookies after restart.

### Webhook environment

```text
/etc/podcast2article-webhook.env
owner: root
group: podcast2article-webhook
mode: 0640
```

Rotating `GITHUB_WEBHOOK_SECRET` requires changing the GitHub webhook secret and
the VPS value together, then restarting `podcast2article-webhook`. A mismatch
causes safe HTTP 401 responses and no deployments.

## 14. Resource controls

### Swap

```text
/swapfile: 2 GiB
/etc/sysctl.d/99-podcast2article.conf: vm.swappiness=10
```

Swap is a safety net for package installation and build peaks, not normal
working memory.

### Application memory

The main Node process starts with:

```text
--max-old-space-size=384
```

The serial job queue prevents concurrent media jobs. The updater uses a 512 MiB
Node heap ceiling during validation and is assigned low CPU and I/O priority by
systemd.

Useful diagnostics:

```bash
free -h
vmstat 1
systemd-cgtop
df -h /
sudo du -sh /var/lib/podcast2article/*
```

Upgrade to a larger VPS if one ordinary job repeatedly causes heavy sustained
swap use, out-of-memory kills, or unacceptable responsiveness.

## 15. Logging

Application, webhook, Caddy, SSH, and systemd logs are stored in journald.

Journald limits:

```text
SystemMaxUse=100M
RuntimeMaxUse=50M
MaxRetentionSec=30day
```

Configuration:

```text
/etc/systemd/journald.conf.d/99-podcast2article.conf
```

Commands:

```bash
sudo journalctl -u podcast2article -f
sudo journalctl -u podcast2article-webhook -f
sudo journalctl -u caddy -f
sudo journalctl -p warning --since today
```

API keys, webhook secrets, passwords, and transcript text should not be logged.

## 16. OS maintenance

Ubuntu unattended security upgrades are enabled. Check with:

```bash
systemctl status unattended-upgrades
sudo unattended-upgrade --dry-run --debug
```

Installed runtime versions can be checked with:

```bash
node --version
python3 --version
caddy version
git --version
```

After a kernel or critical system update, schedule a controlled reboot:

```bash
sudo systemctl status podcast2article
sudo reboot
```

Then verify SSH, Caddy, the application, webhook receiver, path unit, DNS, and
HTTPS.

## 17. Backup status and requirements

### Required status

The repository does not configure an offsite backup. Verify an encrypted,
offsite backup and a successful restore separately. Application code is
recoverable from GitHub, but production data under
`/var/lib/podcast2article` is not recoverable from Git.

### Essential backup scope

```text
/var/lib/podcast2article/users
/etc/podcast2article.env
/etc/podcast2article-webhook.env
/etc/caddy/Caddyfile
/etc/systemd/system/podcast2article*.service
/etc/systemd/system/podcast2article-update.path
/etc/cron.d/podcast2article-update
```

Each user's `media` directory is optional only if source media can reliably be
recovered. It is required to preserve timestamp playback independently of the
original source.

Secrets in backups must be encrypted and access-controlled. A backup stored
only on the same VPS is not an offsite backup.

### Suggested policy

- nightly encrypted backup of jobs and configuration;
- media backup according to retention needs;
- offsite destination or TransIP backup product;
- periodic restore test;
- snapshot before high-risk OS or storage changes.

Do not claim the system is backed up until a restore has been tested.

## 18. Disaster recovery outline

For complete VPS loss:

1. provision an Ubuntu VPS;
2. restore SSH key access and firewall rules;
3. recreate DNS A and AAAA records if addresses changed;
4. install Node.js 22+, Python, Caddy, Git, rsync, and Corepack/Yarn;
5. recreate service accounts;
6. restore encrypted environment files;
7. restore `/var/lib/podcast2article`;
8. install the updater, webhook receiver, systemd units, cron, and Caddyfile;
9. trigger a validated release deployment from GitHub;
10. recreate or update the GitHub webhook URL and secret;
11. verify login, job history, audio, PDF, webhook, cron, IPv4, and IPv6.

Recovery time and recovery point cannot be guaranteed until offsite backups and
restore testing are implemented.

## 19. Routine operational checklist

### Health

```bash
curl -fsS http://127.0.0.1:3000/api/health
curl -I https://production.example.nl/login
systemctl is-active podcast2article podcast2article-webhook caddy
systemctl is-active podcast2article-update.path cron
```

### Current revision

```bash
readlink -f /opt/podcast2article/current
cat /opt/podcast2article/current/.deployed-commit
git ls-remote https://github.com/rogierslag/podcast2article.git refs/heads/main
```

### Recent deployment

```bash
sudo tail -n 100 /var/log/podcast2article-update.log
sudo systemctl status podcast2article-update.service
```

### Storage and memory

```bash
free -h
df -h /
sudo du -sh /var/lib/podcast2article/users/*/jobs
sudo du -sh /var/lib/podcast2article/users/*/media
```

### DNS and certificate

```bash
dig @ns0.transip.nl production.example.nl A +short
dig @ns0.transip.nl production.example.nl AAAA +short
echo | openssl s_client -connect production.example.nl:443 \
  -servername production.example.nl 2>/dev/null \
  | openssl x509 -noout -issuer -dates
```

## 20. Known action items

1. Configure and test an encrypted offsite backup.
2. Confirm the provider-side TransIP firewall definitions in the control panel.
3. Keep deployed Caddy, systemd, cron, and hardening files synchronized with
   the reviewed files under `deploy/`.
4. Revisit VPS sizing after observing several long real-world jobs and update
   builds.
5. Keep this document synchronized with material infrastructure changes.
