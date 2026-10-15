#!/usr/bin/env bash
# Fails if a migration that exists on the base ref was modified, renamed or deleted.
# Applied migrations are immutable (ADR 0004): fix mistakes with a new migration.
set -euo pipefail

base="${1:?usage: scripts/check-migrations-immutable.sh <base-ref>}"
changed="$(git diff --name-status --diff-filter=DMRT "$base"...HEAD -- db/migrations)"

if [[ -n "$changed" ]]; then
  echo "Existing migrations must not change (ADR 0004). Add a new migration instead:" >&2
  echo "$changed" >&2
  exit 1
fi
echo "Migrations OK: only additions relative to $base."
