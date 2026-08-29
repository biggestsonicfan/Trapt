#!/bin/sh
# Push the built site to the droplet and reload the container.
#
#   TRAPT_SITE='E:/.../trapt-site' HOST=root@<droplet-ip> sh deploy/deploy-droplet.sh
#
# Sends originals only.  The .gz/.br sidecars deploy/precompress.py writes are
# skipped on purpose: Cloudflare caches the compressed response at the edge, so
# the origin compresses almost nothing, and Caddy's `encode` covers the rare
# miss.  They would also be ~0.45 GB of duplicate bytes on the droplet.  Drop --exclude if you ever serve this unproxied.
#
# --delete-after removes files that no longer exist in the build *after* the
# new ones are in place, so the site is never briefly incomplete.  It only
# touches the destination directory.
set -eu

SITE="${TRAPT_SITE:?set TRAPT_SITE to the built site directory}"
HOST="${HOST:?set HOST, e.g. root@<droplet-ip>}"
DEST="${DEST:-/srv/trapt-site}"

echo "==> $SITE  ->  $HOST:$DEST"
rsync -az --info=progress2 --delete-after \
      --exclude='*.gz' --exclude='*.br' \
      "$SITE/" "$HOST:$DEST/"

# No restart: the container bind-mounts the directory read-only and Caddy
# serves whatever is on disk, so new files are live as soon as rsync lands.
echo "==> droplet disk, and the container's own health check"
ssh "$HOST" "df -h $DEST | tail -1; docker inspect -f '{{.State.Health.Status}}' trapt 2>/dev/null || echo 'trapt not running'"

echo "==> https://trapt.robkrum.com/"
