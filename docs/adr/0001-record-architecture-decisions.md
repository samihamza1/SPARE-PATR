# 0001. Record architecture decisions; monorepo and tooling

- Status: Accepted
- Date: 2026-10-04

## Context

The stack in CLAUDE.md is a proposal to be confirmed in Sprint 1. Decisions need a
durable, reviewable record, and the tooling must enforce the invariants (strict types,
no floats for money, no literal UI strings) rather than rely on review alone.

## Decision

- Record significant decisions as ADRs in `docs/adr/` (this format).
- pnpm workspaces monorepo: `apps/api`, `apps/pos`, `apps/backoffice`,
  `packages/shared`, `db`. Internal packages are consumed as TypeScript source
  (no build step between workspaces); apps bundle or run them via tsx/Vite.
- Node.js 22 LTS (`.nvmrc`), pnpm pinned via `packageManager`.
- TypeScript 6 in `strict` mode plus `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. Each package runs
  `tsc --noEmit`.
- ESLint (flat config, `typescript-eslint` strict + stylistic type-checked) and
  Prettier. Project rules:
  - money module: no `parseFloat`, `Number(...)`, `.toNumber()`, `.toFixed()`;
  - React apps: `eslint-plugin-i18next` `no-literal-string` for JSX.
- Vitest (one config per workspace, run as projects from the root) and fast-check
  for property-based tests.

## Consequences

- One command each for lint, typecheck and test across the repo; CI runs the same.
- TypeScript 7 (native) is not adopted yet: `typescript-eslint` supports `<6.1`.
  Revisit when it supports 7.
- Packages are not publishable as-is; fine for an application monorepo.

## Alternatives considered

- Biome instead of ESLint + Prettier: faster, single tool, but no equivalent of the
  i18n literal-string rule or the React hooks rules we need.
- Nx / Turborepo: unnecessary at this size; can be added for caching later.
- Jest: slower, weaker ESM/TypeScript support than Vitest.
