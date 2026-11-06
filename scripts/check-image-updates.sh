#!/usr/bin/env bash
#
# Monthly: report pinned images whose tag now points at a newer upstream
# digest. Never changes anything — updating an image is a deliberate step:
#   docker pull <tag>; test; replace the @sha256 digest in docker-compose.yml.
set -uo pipefail

APP_DIR="${WWWIDE_APP_DIR:-/opt/web-world-wide}"
SCRIPT_DIR="$APP_DIR/scripts"
# shellcheck source=scripts/_notify.sh
. "$SCRIPT_DIR/_notify.sh"

outdated=()
while read -r ref; do
  tag="${ref%@*}"
  pinned="${ref#*@}"
  # Resolve the tag's current manifest-list digest without pulling layers.
  latest="$(docker buildx imagetools inspect "$tag" --format '{{json .Manifest.Digest}}' 2>/dev/null | tr -d '"')"
  if [ -z "$latest" ]; then
    echo "$(date -Is) [images] could not resolve $tag"
    continue
  fi
  if [ "$latest" != "$pinned" ]; then
    outdated+=("$tag")
    echo "$(date -Is) [images] update available: $tag ($pinned -> $latest)"
  else
    echo "$(date -Is) [images] up to date: $tag"
  fi
done < <(grep -oP 'image:\s*\K\S+@sha256:[0-9a-f]+' "$APP_DIR/docker/docker-compose.yml")

if [ "${#outdated[@]}" -gt 0 ]; then
  wwwide_notify image-updates 2419200 \
    "Newer container images are available: ${outdated[*]}. Review release notes, then bump the digests in docker/docker-compose.yml."
fi
