# 0002. API framework: Fastify

- Status: Accepted
- Date: 2026-10-04

## Context

`apps/api` is a Node.js REST API. It serves the back office and the POS sync endpoints
(which must be idempotent). Every tenant-scoped request must run inside one transaction
that starts with `SET LOCAL app.tenant_id`. Request and response validation should reuse
the zod schemas in `@autoparts/shared`.

## Decision

**Fastify 5.**

- Request lifecycle hooks (`onRequest`, `preHandler`, `onResponse`) and encapsulated
  plugins are a natural place to resolve the tenant and wrap handlers in `withTenant`.
- Schema-driven validation and serialisation, with zod through `fastify-type-provider-zod`
  when the first real endpoints arrive (also yields OpenAPI via `@fastify/swagger`).
- Mature, fast, and built-in structured logging (pino), with `inject()` for tests that
  need no open port.
- `buildServer(deps)` takes its dependencies explicitly so tests can stub them.
  `main.ts` does the wiring.
- Production build: tsup bundles the workspace packages; npm dependencies stay external.

## Alternatives considered

- **Hono**: lightweight and edge-friendly with good zod support. Its Node ecosystem
  (logging, plugins, OpenAPI) is thinner, and we do not need edge runtimes; the database
  is regional Postgres.
- **NestJS**: batteries included, but decorators, DI containers and its module system add
  weight and indirection that a small team does not need.
- **Express 5**: ubiquitous, but no built-in schema validation, typing or logging; we
  would assemble what Fastify ships.

## Consequences

- Handlers are plain async functions. Cross-cutting concerns (tenant, auth, idempotency
  keys) become Fastify plugins/hooks.
- Sprint 1 ships only `/health` and `/health/db`. Auth and tenant resolution come with the
  first business endpoints.
