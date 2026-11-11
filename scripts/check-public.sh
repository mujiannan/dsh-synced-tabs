#!/usr/bin/env bash
# Fails when a private reference slips into a tracked file. The public repository
# is mirrored from a private workspace, so this list is the guard that keeps the
# two from re-converging by accident. Only tracked files are scanned: that is
# exactly the set that becomes public.
set -euo pipefail

patterns='mujiannan\.com|gitea|vault-warden|192\.168\.|/home/shennan|MJN/'

hits=$(git grep -nIE "$patterns" -- . ':(exclude)scripts/check-public.sh' || true)

# The public repository URL itself is fine; nothing under github.com/mujiannan is private.
hits=$(printf '%s\n' "$hits" | grep -v 'github\.com/mujiannan' | grep -v '^$' || true)

if [ -n "$hits" ]; then
  echo "$hits"
  echo
  echo "private references found; refusing to publish"
  exit 1
fi

echo "no private references"
