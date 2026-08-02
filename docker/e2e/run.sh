#!/usr/bin/env bash
# Build and run the sandbox, then remove the container. Nothing here touches the
# host's ~/.maw, ~/.claude, tmux server or any live service — that isolation is
# the entire point, so this script never runs maw or kobo outside the container.
#
#   docker/e2e/run.sh                          # v0 + v1
#   docker/e2e/run.sh /home/maw/e2e/tests/v0-image.sh
#   docker/e2e/run.sh bash                     # poke around inside
#
# KOBO_REF pins the kobo revision under test (default origin/main).
set -euo pipefail

cd "$(dirname "$0")"

KOBO_SRC="${KOBO_SRC:-$HOME/ghq/github.com/meganechan/kobo-board}"
KOBO_REF="${KOBO_REF:-origin/main}"

if [ ! -d "$KOBO_SRC/.git" ]; then
  echo "no kobo-board clone at $KOBO_SRC — set KOBO_SRC" >&2
  exit 1
fi

# Clone at a pinned ref rather than mounting $KOBO_SRC directly. Two reasons, both
# learned the hard way: a working checkout sits on whatever branch someone last left
# it on (ours was on a stale feature branch, which silently changed what the suite
# appeared to prove), and bin/kobo derives KOBO_RUNTIME_SHA by running `git -C
# $KOBO_REPO rev-parse HEAD`, so the mount must be a real repo — a `git worktree`
# will not do, its .git is a pointer to a gitdir that does not exist in the
# container. A local clone needs no network and no auth, so a private repo is fine.
git -C "$KOBO_SRC" fetch origin --quiet
KOBO_SHA="$(git -C "$KOBO_SRC" rev-parse "$KOBO_REF")"

KOBO_TMP="$(mktemp -d)"
export KOBO_MOUNT="$KOBO_TMP/kobo-board-runtime"
git clone --quiet --no-hardlinks "$KOBO_SRC" "$KOBO_MOUNT"
git -C "$KOBO_MOUNT" checkout --quiet --detach "$KOBO_SHA"
echo "kobo $KOBO_REF -> ${KOBO_SHA:0:8}"

# `run --rm` already removes the container it creates; the down catches anything
# left behind by an interrupted build or a crashed run.
cleanup() {
  docker compose -f compose.yml down --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$KOBO_TMP"
}
trap cleanup EXIT

docker compose -f compose.yml build
docker compose -f compose.yml run --rm e2e "$@"
