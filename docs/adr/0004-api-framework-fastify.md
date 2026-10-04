# 0004. API framework: Fastify

- Status: Accepted
- Date: 2026-10-04

## Context

The REST API serves the POS (including idempotent sync endpoints) and the
back office. Every request that touches tenant data must run in a tenant-scoped
transaction; request and response bodies must be validated (decimal strings,
UUID v7). We want structured logging and good testability without a server.

## Decision

Use **Fastify 5**.

- Request lifecycle hooks are where authentication will resolve the tenant and
  wrap handlers in `withTenant` (later sprint).
- Validation with zod schemas from `packages/shared`, wired through the official
  `@fastify/type-provider-zod` when the first validated route lands.
- pino logging (built in); `app.inject()` for tests without opening a port.
- `buildApp({ db })` takes its dependencies explicitly; `server.ts` only wires
  configuration (validated with zod) and starts listening.

## Consequences

- Mature plugin ecosystem (CORS, rate limiting, OpenAPI via @fastify/swagger).
- Plugin encapsulation has a learning curve; keep the plugin tree shallow.

## Alternatives considered

- **Hono**: small and fast, runs on edge runtimes; we do not need edge deployment
  and Fastify's Node ecosystem is broader.
- **NestJS**: heavy DI/decorator framework; adds ceremony and hides the
  transaction boundary we want to keep explicit.
- **Express**: no built-in schema validation or typed routes; slower.
