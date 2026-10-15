#!/usr/bin/env bash
# Records the SHA-256 of every migration in db/migrations.sha256. CI checks that migrations
# recorded on the base branch never change (scripts/check-migrations-immutable.sh).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)/db/migrations"
sha256sum -- *.sql > ../migrations.sha256
