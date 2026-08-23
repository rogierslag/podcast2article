#!/usr/bin/env bash
set -Eeuo pipefail

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export YARN_CACHE_FOLDER=/var/cache/podcast2article-yarn
export NODE_OPTIONS=--max-old-space-size=512

repository="https://github.com/rogierslag/podcast2article.git"
branch="main"
application_root="/opt/podcast2article"
release_root="$application_root/releases"
current_link="$application_root/current"
service="podcast2article.service"
build_directory=""

log() {
  printf '%s %s\n' "$(date --iso-8601=seconds)" "$*"
}

cleanup() {
  case "$build_directory" in
    /var/tmp/podcast2article-update.*) rm -rf -- "$build_directory" ;;
  esac
}
trap cleanup EXIT

exec 9>/run/lock/podcast2article-update.lock
if ! flock -n 9; then
  log "Another update is already running; skipping"
  exit 0
fi

remote_commit="$(git ls-remote "$repository" "refs/heads/$branch" | awk 'NR == 1 { print $1 }')"
if [[ ! "$remote_commit" =~ ^[0-9a-f]{40}$ ]]; then
  log "Could not resolve $branch on $repository"
  exit 1
fi

current_release="$(readlink -f "$current_link" 2>/dev/null || true)"
current_commit=""
if [[ -n "$current_release" && -r "$current_release/.deployed-commit" ]]; then
  current_commit="$(<"$current_release/.deployed-commit")"
fi

if [[ "$current_commit" == "$remote_commit" ]]; then
  log "Already current at ${remote_commit:0:12}"
  exit 0
fi

release_name="$(date +%Y%m%d-%H%M%S)-${remote_commit:0:12}"
new_release="$release_root/$release_name"
if [[ -e "$new_release" ]]; then
  log "Release path already exists: $new_release"
  exit 1
fi

build_directory="$(mktemp -d /var/tmp/podcast2article-update.XXXXXX)"
log "Validating ${remote_commit:0:12} in $build_directory"
git -C "$build_directory" init --quiet
git -C "$build_directory" remote add origin "$repository"
git -C "$build_directory" fetch --quiet --depth=1 origin "$remote_commit"
git -C "$build_directory" checkout --quiet --detach FETCH_HEAD

corepack yarn --cwd "$build_directory" install --frozen-lockfile --non-interactive
corepack yarn --cwd "$build_directory" run check

install -d -o root -g root -m 0755 "$new_release"
rsync -rlpt \
  --exclude=.git \
  --exclude=node_modules \
  --exclude=data \
  --exclude=output \
  "$build_directory/" "$new_release/"

corepack yarn --cwd "$new_release" install --frozen-lockfile --production --non-interactive
ln -s /var/lib/podcast2article "$new_release/data"
printf '%s\n' "$remote_commit" >"$new_release/.deployed-commit"
chown -R root:root "$new_release"
chmod -R u=rwX,go=rX "$new_release"

previous_target="$(readlink "$current_link" 2>/dev/null || true)"
temporary_link="$application_root/.current.$release_name"
ln -s "releases/$release_name" "$temporary_link"
mv -Tf "$temporary_link" "$current_link"

log "Activating $release_name"
if systemctl restart "$service"; then
  for _ in $(seq 1 30); do
    if systemctl is-active --quiet "$service" && curl -fsS http://127.0.0.1:3000/api/health | grep -q '"ok":true'; then
      log "Deployment successful: $release_name"
      find "$release_root" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
        | sort -nr \
        | awk 'NR > 3 { sub(/^[^ ]+ /, ""); print }' \
        | while IFS= read -r old_release; do
            case "$old_release" in
              "$release_root"/*) rm -rf -- "$old_release" ;;
            esac
          done
      exit 0
    fi
    sleep 1
  done
fi

log "Health check failed; rolling back"
if [[ -n "$previous_target" ]]; then
  rollback_link="$application_root/.rollback.$release_name"
  ln -s "$previous_target" "$rollback_link"
  mv -Tf "$rollback_link" "$current_link"
  systemctl restart "$service"
fi
exit 1
