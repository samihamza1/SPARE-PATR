#!/usr/bin/env bash
# Applied migrations are immutable (ADR 0004): fix mistakes with a new migration.
#
# db/migrations.sha256 records the SHA-256 of every migration (sha256sum format). This
# check fails when:
#   - a migration and its recorded hash disagree, or either one is missing;
#   - given a base ref (the PR base, or the commit before a push), a migration recorded
#     there was changed, renamed or removed here.
# A base without the manifest (older history) is compared file by file instead.
# After adding a migration, record it with `pnpm db:manifest`.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

manifest=db/migrations.sha256
base="${1:-}"

listed="$(awk '{print $2}' "$manifest" | sort)"
present="$(find db/migrations -maxdepth 1 -name '*.sql' -printf '%f\n' | sort)"
if [[ "$listed" != "$present" ]]; then
  echo "$manifest and db/migrations disagree (run pnpm db:manifest after adding one):" >&2
  diff <(echo "$listed") <(echo "$present") >&2 || true
  exit 1
fi
if ! (cd db/migrations && sha256sum --check --quiet --strict "../${manifest#db/}"); then
  echo "A migration no longer matches its recorded hash (ADR 0004)." >&2
  exit 1
fi

if [[ -n "$base" ]]; then
  if git cat-file -e "$base:$manifest" 2>/dev/null; then
    changed="$(comm -23 <(git show "$base:$manifest" | sort) <(sort "$manifest"))"
  elif git cat-file -e "$base" 2>/dev/null; then
    changed="$(git diff --name-status --diff-filter=DMRT "$base"...HEAD -- db/migrations)"
  else
    echo "Base $base is not available; compared with the manifest only." >&2
    changed=""
  fi
  if [[ -n "$changed" ]]; then
    echo "Migrations applied on $base were changed or removed (ADR 0004):" >&2
    echo "$changed" >&2
    exit 1
  fi
fi
echo "Migrations OK."
