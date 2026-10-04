# 0001. Monorepo layout and tooling

- Status: Accepted
- Date: 2026-10-04

## Context

One product with an API, an offline-first POS, a back office and shared domain code
(money, schemas, i18n). The shared code must be identical on server and client,
especially money maths. The team is small, so tooling should be simple.

## Decision

- **pnpm workspaces**: `apps/*`, `packages/*` and `db`. No Turborepo/Nx for now;
  `pnpm -r` is enough at this size. Add a task runner when builds get slow.
- **Internal packages export TypeScript source** (`"exports": "./src/index.ts"`). There is
  no build step between packages in development. Vite, Vitest and tsx consume TS
  directly. `apps/api` is bundled with tsup for production.
- **TypeScript 6, strict** plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
  and `verbatimModuleSyntax`. `moduleResolution: Bundler` everywhere. TS 7 (native)
  waits until typescript-eslint supports it.
- **ESLint** (flat config, `typescript-eslint` strict-type-checked) **+ Prettier**. Lint
  rules enforce invariants where they are cheap to check:
  - no `parseFloat`/`Number()`/unary `+`/`Math.round` in money and DB code (invariant 1);
  - `i18next/no-literal-string` in UI components (invariant 8).
- **Vitest** for all tests, **fast-check** for property-based tests.
- **Node 24 LTS** in CI (`engines: >=22.12`); pnpm pinned via `packageManager`.

## Alternatives considered

- **Turborepo / Nx**: caching is useful later. Today it adds config without a payoff.
- **Biome** instead of ESLint + Prettier: faster, but it lacks the type-aware rules we
  rely on (`no-floating-promises`, `strict-boolean-expressions`, etc.) and the i18n plugin.
- **Building internal packages** (tsc project references): more moving parts and slower
  feedback for no benefit while all consumers can read TS.

## Consequences

- One `pnpm install`, one lockfile, one lint/format config.
- Consumers of `@autoparts/shared` must be able to compile TS (all of ours can).
- Revisit the task runner once CI time becomes a problem.
