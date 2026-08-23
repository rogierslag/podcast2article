# Production deployment

This directory contains the non-secret configuration used by the native
systemd deployment. The current production host uses Ubuntu, Node.js 22,
Python, Caddy, Git, rsync, Corepack/Yarn, cron, UFW, and a 2 GiB swapfile.

The installer is intentionally conservative:

- it never overwrites existing environment files;
- it does not generate or print secrets;
- host hardening and firewall changes require explicit flags;
- it validates Caddy and SSH configuration before reloading services;
- it does not create a swapfile or change DNS/provider firewall settings.

Full application architecture is documented in `../ARCHITECTURE.md`. The
operational runbook is in `../docs/OPERATIONS.md`.

## 1. Prerequisites

Install and verify:

```bash
node --version       # 22 or newer
python3 --version    # 3.9 or newer
caddy version
git --version
rsync --version
corepack --version
```

Point the production hostname's A and AAAA records at the VPS. Allow inbound
TCP ports 22, 80, and 443 in the provider firewall.

Keep a second, key-authenticated SSH session open before applying SSH or UFW
hardening.

## 2. Install service definitions

From a checked-out repository on the VPS:

```bash
sudo deploy/install-infrastructure.sh --check
sudo deploy/install-infrastructure.sh
```

This installs application, webhook, updater, path, cron, logrotate, and Caddy
configuration. It creates secret-free environment files only when they do not
already exist.

## 3. Configure secrets

Edit the application environment:

```bash
sudoedit /etc/podcast2article.env
```

At minimum configure:

```dotenv
OPENAI_API_KEY=<secret>
APP_PASSWORD=<long-random-secret>
OPENAI_REGION=eu
HOST=127.0.0.1
PORT=3000
```

Edit the webhook environment:

```bash
sudoedit /etc/podcast2article-webhook.env
```

Generate a 256-bit value in a private terminal and store the same value as the
GitHub webhook secret:

```bash
openssl rand -hex 32
```

Never commit either `/etc` environment file.

## 4. Apply optional host hardening

After confirming a second SSH session works:

```bash
sudo deploy/install-infrastructure.sh --apply-host-hardening
sudo sshd -t
```

To also configure UFW:

```bash
sudo deploy/install-infrastructure.sh --configure-firewall
sudo ufw status verbose
```

The firewall mode allows TCP 22, 80, and 443 for IPv4 and IPv6 and denies other
incoming traffic.

## 5. Configure swap separately

On a one-GB VPS, configure a 2 GiB swapfile once. Resolve the exact target
before running these commands and do not repeat `mkswap` on an active file:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
sudo sysctl --system
```

Verify:

```bash
sudo swapon --show
free -h
```

## 6. Bootstrap the first release

After configuring both environment files:

```bash
sudo systemctl start podcast2article-webhook.service
sudo systemctl start podcast2article-update.service
sudo tail -f /var/log/podcast2article-update.log
```

The updater fetches the exact `main` commit, installs locked dependencies,
builds, tests, creates an immutable release, switches the `current` symlink,
starts the app, performs a health check, and rolls back on failure.

## 7. Configure the GitHub webhook

Create a repository webhook with:

```text
Payload URL:  https://<production-host>/hooks/github
Content type: application/json
Secret:       same value as GITHUB_WEBHOOK_SECRET
SSL verify:   enabled
Events:       push only
```

The receiver accepts only signed pushes for
`rogierslag/podcast2article` on `refs/heads/main`.

## 8. Verify

```bash
sudo systemctl status podcast2article
sudo systemctl status podcast2article-webhook
sudo systemctl status podcast2article-update.path
sudo systemctl status caddy

curl -fsS http://127.0.0.1:3000/api/health
curl -I https://<production-host>/login
sudo tail -n 100 /var/log/podcast2article-update.log
```

An unsigned request must fail without creating a trigger:

```bash
curl -i -X POST -H 'content-type: application/json' \
  --data '{}' https://<production-host>/hooks/github
```

Expected status: `401 Unauthorized`.

## 9. Updating infrastructure

Application releases do not automatically install changed Caddy, systemd,
cron, SSH, or journald files. After reviewing an infrastructure change, apply
it explicitly:

```bash
git pull --ff-only
sudo deploy/install-infrastructure.sh
```

Use the hardening flags only when the corresponding host configuration should
also be updated.

## 10. Do not commit

- `.env` or `/etc/podcast2article*.env`;
- webhook secrets, API keys, or application passwords;
- `data/jobs`, `data/media`, or backups;
- Caddy certificate storage;
- SSH private keys.
