# AutoParts POS & Accounting

Multi-tenant POS and accounting for car spare-parts shops. Arabic-first (RTL), offline-capable
selling. Project rules and invariants: [CLAUDE.md](CLAUDE.md). Decisions: [docs/adr](docs/adr).

## Layout

| Path              | What                                                          |
| ----------------- | ------------------------------------------------------------- |
| `apps/api`        | Fastify REST API ([ADR 0002](docs/adr/0002-api-framework.md)) |
| `apps/pos`        | POS web app (React + Vite; offline/PWA in a later sprint)     |
| `apps/backoffice` | Back office web app (React + Vite)                            |
| `packages/shared` | Money maths, zod schemas, UUID v7 ids, i18n helpers           |
| `db`              | SQL migrations, role bootstrap, Kysely client, RLS tests      |
| `docs/adr`        | Architecture decision records                                 |

## Getting started

Requirements: Node 24 (22.12+ works), pnpm via `corepack enable`, Docker.

```sh
pnpm install
cp .env.example .env      # local-only credentials
pnpm db:up                # PostgreSQL 18; first start creates roles and databases
pnpm db:migrate
pnpm test
pnpm dev                  # API :3000, POS :5173, back office :5174
```

## Commands

| Command                           | Does                                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                        | Runs the API and both web apps                                                                                          |
| `pnpm lint` / `pnpm format:check` | ESLint (incl. money and i18n guard rails) / Prettier                                                                    |
| `pnpm typecheck`                  | `tsc` in every package                                                                                                  |
| `pnpm test`                       | `test:unit` + `test:db`                                                                                                 |
| `pnpm test:db`                    | Recreates `autoparts_test`, checks every migration down and up, runs RLS tests and API integration tests                |
| `pnpm db:migrate`                 | Applies pending migrations to the dev database                                                                          |
| `pnpm db:new <name>`              | Creates `db/migrations/<timestamp>_<name>.sql`                                                                          |
| `pnpm db:codegen`                 | Regenerates Kysely types; run after every migration and commit                                                          |
| `pnpm tenant:create --slug … `    | Provisions a tenant with its functional currency, system roles and owner user (see `apps/api/src/cli/tenant-create.ts`) |
| `pnpm build`                      | Builds the API (tsup) and the web apps (Vite)                                                                           |

## Database roles

- `autoparts_owner` owns the schema and runs migrations.
- `autoparts_app` is what the API uses. It has no `BYPASSRLS`, owns nothing and has no
  `DELETE`.

Every tenant table has forced row-level security. Tenant-scoped work runs inside
`withTenant(db, tenantId, fn)`. See [ADR 0006](docs/adr/0006-tenant-isolation-with-rls.md).
Adding a table without a tenant policy fails `pnpm test:db`.
