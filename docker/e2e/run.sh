#!/usr/bin/env bash
# Build and run the sandbox, then remove the container. Nothing here touches the
# host's ~/.maw, ~/.claude, tmux server or any live service — that isolation is
# the entire point, so this script never runs maw or kobo outside the container.
#
#   docker/e2e/run.sh                          # v0 + v1
#   docker/e2e/run.sh /home/maw/e2e/tests/v0-image.sh
#   docker/e2e/run.sh bash                     # poke around inside
set -euo pipefail

cd "$(dirname "$0")"

export KOBO_REPO="${KOBO_REPO:-$HOME/ghq/github.com/meganechan/kobo-board}"
if [ ! -d "$KOBO_REPO/src" ]; then
  echo "no kobo-board checkout at $KOBO_REPO — set KOBO_REPO" >&2
  exit 1
fi

# `run --rm` already removes the container it creates; this catches anything left
# behind by an interrupted build or a crashed run.
cleanup() { docker compose -f compose.yml down --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker compose -f compose.yml build
docker compose -f compose.yml run --rm e2e "$@"
