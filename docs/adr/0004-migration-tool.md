# 0004. Migration tool: dbmate

- Status: Accepted
- Date: 2026-10-04

## Context

Migrations are plain SQL in `db/migrations/*.sql` (CLAUDE.md). They create roles' grants,
RLS policies, triggers and functions, so the tool must run arbitrary SQL. It must work
the same locally, in CI and in deployment, and be safe to run concurrently.

## Decision

- **dbmate** (the `dbmate` npm package ships the binary per platform).
  - Files: `YYYYMMDDHHMMSS_name.sql` with `-- migrate:up` / `-- migrate:down` sections.
  - Each file runs in a transaction. Applied versions live in `schema_migrations`.
- Invoked through `pnpm db:migrate | db:new | db:codegen`. `db/scripts/with-env.js` loads
  the root `.env` when present; CI passes variables directly.
- Migrations run as `autoparts_owner`. Roles and databases are cluster-level and are
  created by `db/bootstrap/00-roles.sh`, not by migrations (passwords stay out of SQL).
- Schema dumps are disabled (`--no-dump-schema`), so the result does not depend on the
  local `pg_dump` version. The reviewed schema artefact is the generated Kysely types.
- **Applied migrations are immutable.** dbmate keeps no checksums. Instead, CI fails a
  pull request that modifies, renames or deletes an existing migration
  (`scripts/check-migrations-immutable.sh`). Fixes are new migrations.
- The DB test setup migrates up, rolls every migration back, and migrates up again, so
  every `down` section is exercised. Downs are for development only. Production
  corrections are always forward migrations.

## Alternatives considered

- **In-house runner** (~150 lines: advisory lock, checksums): full control, but more code
  to own. We can switch later because the file format is plain SQL.
- **graphile-migrate**: good, but opinionated about workflow (current.sql, watch mode).
- **node-pg-migrate**: JS-first; SQL files are second-class.
- **Kysely Migrator**: migrations written in TypeScript, contrary to SQL-first.

## Consequences

- No checksum protection inside the tool; the CI rule above covers it.
- New contributors need only `pnpm install` (no global binaries).

## Addendum (2026-10-07, Sprints 1–3 review)

- dbmate keeps no checksums, and the pull-request check compared with a base branch that
  had no migrations, so an edited migration could pass.
- `db/migrations.sha256` now records the SHA-256 of every migration
  (`pnpm db:manifest`).
- CI runs `scripts/check-migrations-immutable.sh` on every push and pull request:
  - every file must match its recorded hash;
  - every migration recorded on the base, or on the commit before a push, must be
    unchanged.
