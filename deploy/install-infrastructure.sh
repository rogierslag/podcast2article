#!/usr/bin/env bash
set -Eeuo pipefail

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
apply_host_hardening=false
configure_firewall=false
check_only=false

usage() {
  cat <<'EOF'
Usage: sudo deploy/install-infrastructure.sh [options]

Installs or updates Podcast2Article services without overwriting existing
secret environment files.

Options:
  --apply-host-hardening  Install journald, sysctl, and SSH hardening files.
  --configure-firewall    Configure UFW for public TCP ports 22, 80, and 443.
                          Implies --apply-host-hardening.
  --check                 Validate prerequisites and configuration without
                          changing the host.
  --help                  Show this help.

Run the default mode first. Only enable host hardening after verifying a second
key-authenticated SSH session to the server.
EOF
}

while (($#)); do
  case "$1" in
    --apply-host-hardening) apply_host_hardening=true ;;
    --configure-firewall)
      apply_host_hardening=true
      configure_firewall=true
      ;;
    --check) check_only=true ;;
    --help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'Required command is missing: %s\n' "$1" >&2
    exit 1
  }
}

for command_name in caddy corepack curl git install node rsync systemctl; do
  require_command "$command_name"
done

node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if [[ ! "$node_major" =~ ^[0-9]+$ ]] || ((node_major < 22)); then
  printf 'Node.js 22 or newer is required. Found: %s\n' "$(node --version)" >&2
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  printf 'Run this installer with sudo or as root.\n' >&2
  exit 1
fi

if $check_only; then
  require_command sshd
  require_command systemd-analyze
  caddy validate --config "$repository_root/deploy/Caddyfile"
  systemd-analyze verify \
    "$repository_root/deploy/podcast2article.service" \
    "$repository_root/deploy/podcast2article-webhook.service" \
    "$repository_root/deploy/podcast2article-update.service" \
    "$repository_root/deploy/podcast2article-update.path"
  ssh_check="$(mktemp /tmp/podcast2article-sshd-check.XXXXXX)"
  trap 'rm -f "$ssh_check"' EXIT
  cp /etc/ssh/sshd_config "$ssh_check"
  printf '\nInclude %s\n' "$repository_root/deploy/podcast2article-ssh.conf" >>"$ssh_check"
  sshd -T -f "$ssh_check" >/dev/null
  printf 'Infrastructure prerequisites and configuration are valid.\n'
  exit 0
fi

if ! id podcast2article >/dev/null 2>&1; then
  useradd --system --home /var/lib/podcast2article --create-home --shell /usr/sbin/nologin podcast2article
fi
if ! id podcast2article-webhook >/dev/null 2>&1; then
  useradd --system --home /nonexistent --no-create-home --shell /usr/sbin/nologin podcast2article-webhook
fi

install -d -o root -g root -m 0755 /opt/podcast2article /opt/podcast2article/releases
install -d -o podcast2article -g podcast2article -m 0750 \
  /var/lib/podcast2article \
  /var/lib/podcast2article/jobs \
  /var/lib/podcast2article/media \
  /var/lib/podcast2article/work
install -d -o root -g root -m 0755 \
  /usr/local/lib/podcast2article \
  /var/cache/podcast2article-yarn \
  /etc/systemd/system

install -o root -g root -m 0755 \
  "$repository_root/scripts/update-production.sh" \
  /usr/local/sbin/update-podcast2article
install -o root -g root -m 0755 \
  "$repository_root/scripts/github-webhook-server.mjs" \
  /usr/local/lib/podcast2article/github-webhook-server.mjs

for unit in \
  podcast2article.service \
  podcast2article-webhook.service \
  podcast2article-update.service \
  podcast2article-update.path; do
  install -o root -g root -m 0644 \
    "$repository_root/deploy/$unit" "/etc/systemd/system/$unit"
done

install -o root -g root -m 0644 \
  "$repository_root/deploy/podcast2article-update.cron" \
  /etc/cron.d/podcast2article-update
install -o root -g root -m 0644 \
  "$repository_root/deploy/podcast2article-update.logrotate" \
  /etc/logrotate.d/podcast2article-update

caddy validate --config "$repository_root/deploy/Caddyfile"
install -o root -g root -m 0644 "$repository_root/deploy/Caddyfile" /etc/caddy/Caddyfile

if [[ ! -e /etc/podcast2article.env ]]; then
  install -o root -g podcast2article -m 0640 "$repository_root/.env.example" /etc/podcast2article.env
  printf 'Created /etc/podcast2article.env from the secret-free example; configure it before starting the app.\n'
else
  chown root:podcast2article /etc/podcast2article.env
  chmod 0640 /etc/podcast2article.env
fi

if [[ ! -e /etc/podcast2article-webhook.env ]]; then
  install -o root -g podcast2article-webhook -m 0640 \
    "$repository_root/deploy/podcast2article-webhook.env.example" \
    /etc/podcast2article-webhook.env
  printf 'Created /etc/podcast2article-webhook.env from the secret-free example; configure it before starting the receiver.\n'
else
  chown root:podcast2article-webhook /etc/podcast2article-webhook.env
  chmod 0640 /etc/podcast2article-webhook.env
fi

if [[ ! -e /var/log/podcast2article-update.log ]]; then
  install -o root -g adm -m 0640 /dev/null /var/log/podcast2article-update.log
else
  chown root:adm /var/log/podcast2article-update.log
  chmod 0640 /var/log/podcast2article-update.log
fi

if $apply_host_hardening; then
  install -d -o root -g root -m 0755 /etc/systemd/journald.conf.d /etc/sysctl.d /etc/ssh/sshd_config.d
  install -o root -g root -m 0644 \
    "$repository_root/deploy/podcast2article-journald.conf" \
    /etc/systemd/journald.conf.d/99-podcast2article.conf
  install -o root -g root -m 0644 \
    "$repository_root/deploy/podcast2article-sysctl.conf" \
    /etc/sysctl.d/99-podcast2article.conf

  ssh_target=/etc/ssh/sshd_config.d/99-podcast2article.conf
  ssh_backup=""
  if [[ -e "$ssh_target" ]] && ! cmp -s "$repository_root/deploy/podcast2article-ssh.conf" "$ssh_target"; then
    ssh_backup="${ssh_target}.backup.$(date +%Y%m%d-%H%M%S)"
    cp -a "$ssh_target" "$ssh_backup"
  fi
  install -o root -g root -m 0644 "$repository_root/deploy/podcast2article-ssh.conf" "$ssh_target"
  if ! sshd -t; then
    if [[ -n "$ssh_backup" ]]; then cp -a "$ssh_backup" "$ssh_target"; else rm -f "$ssh_target"; fi
    printf 'SSH validation failed; the previous configuration was restored.\n' >&2
    exit 1
  fi

  sysctl --system >/dev/null
  systemctl restart systemd-journald
  systemctl reload ssh
fi

if $configure_firewall; then
  require_command ufw
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
fi

systemctl daemon-reload
systemctl enable --now cron caddy podcast2article-update.path
systemctl restart podcast2article-update.path
systemctl reload caddy

if grep -Eq '^GITHUB_WEBHOOK_SECRET=.{32,}$' /etc/podcast2article-webhook.env; then
  systemctl enable podcast2article-webhook.service
  systemctl restart podcast2article-webhook.service
else
  systemctl disable --now podcast2article-webhook.service >/dev/null 2>&1 || true
  printf 'Webhook receiver not started: configure GITHUB_WEBHOOK_SECRET first.\n'
fi

if grep -Eq '^OPENAI_API_KEY=.+$' /etc/podcast2article.env && grep -Eq '^APP_PASSWORD=.+$' /etc/podcast2article.env; then
  systemctl enable podcast2article.service
  if [[ -e /opt/podcast2article/current ]]; then
    systemctl restart podcast2article.service
  else
    printf 'No current release exists; trigger podcast2article-update.service after reviewing configuration.\n'
  fi
else
  systemctl disable --now podcast2article.service >/dev/null 2>&1 || true
  printf 'Application not started: configure OPENAI_API_KEY and APP_PASSWORD first.\n'
fi

printf 'Infrastructure files installed successfully. See deploy/README.md for provisioning and verification steps.\n'
