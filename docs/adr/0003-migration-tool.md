# 0003. Migrations: in-house forward-only SQL runner

- Status: Accepted
- Date: 2026-10-04

## Context

Migrations are plain SQL files in `db/migrations/*.sql` and carry security-critical
content (RLS policies, FORCE, grants, append-only triggers). We need ordering,
idempotent re-runs, protection against editing history and against two deploys
migrating at once. Roles are cluster-wide and need passwords, which do not belong
in migration files.

## Decision

A small runner in `db/src/migrate.ts` (~100 lines, depends only on `pg`):

- Files are `NNNN_snake_name.sql`, numbered from 0001 without gaps or duplicates;
  any other file in the directory is an error.
- Each file runs in its own transaction; the version, name and SHA-256 checksum are
  recorded in `schema_migrations`.
- A PostgreSQL advisory lock serialises concurrent runs.
- **Forward-only**: there are no down migrations. If an applied file changes, the
  runner refuses to start; a correction is a new migration. This mirrors the
  append-only rule for business data.
- Migrations run as `autoparts_owner`. Cluster-level setup (roles, database,
  schema privileges) is a separate, idempotent `pnpm db:bootstrap` run as a
  superuser.

## Consequences

- Tested behaviour (order, no-op re-run, checksum tamper, rollback on failure,
  concurrency) is under our control and cheap to extend.
- Statements that cannot run in a transaction (e.g. `CREATE INDEX CONCURRENTLY`)
  are not supported yet; add an opt-out marker when first needed.
- Rolling back a deploy means deploying a new forward migration.

## Alternatives considered

- **dbmate**: plain SQL, simple; but up/down in one file, no checksum verification
  and a Go binary in the toolchain.
- **node-pg-migrate**: JS-first API; SQL files are a secondary mode.
- **graphile-migrate**: SQL-first with a nice dev loop, but opinionated
  (current.sql workflow) and more than we need.
- **Flyway**: mature checksums and versioning, but a JVM dependency and paid
  features for some workflows.
