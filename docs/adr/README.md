# Architecture Decision Records

Short records of significant decisions. One file per decision: `NNNN-title.md`.
An accepted ADR is not edited to change the decision; write a new ADR that supersedes it.

Template:

```md
# NNNN. Title

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD

## Context

## Decision

## Alternatives considered

## Consequences
```

| #                                           | Decision                                                    |
| ------------------------------------------- | ----------------------------------------------------------- |
| [0001](0001-monorepo-and-tooling.md)        | Monorepo layout and tooling                                 |
| [0002](0002-api-framework.md)               | API framework: Fastify                                      |
| [0003](0003-query-layer.md)                 | Query layer: Kysely                                         |
| [0004](0004-migration-tool.md)              | Migration tool: dbmate                                      |
| [0005](0005-money-representation.md)        | Money representation: decimal.js                            |
| [0006](0006-tenant-isolation-with-rls.md)   | Tenant isolation with Postgres RLS                          |
| [0007](0007-authentication-and-sessions.md) | Authentication and sessions                                 |
| [0008](0008-tenant-resolution-at-login.md)  | Resolving the tenant at login                               |
| [0009](0009-permissions-and-roles.md)       | Permissions and roles                                       |
| [0010](0010-tenant-settings.md)             | Tenant settings                                             |
| [0011](0011-devices-and-offline-pin.md)     | Device enrollment and offline PIN (design)                  |
| [0012](0012-ui-stack.md)                    | UI stack: Mantine, React Router, TanStack Query; Playwright |
| [0013](0013-shared-vehicle-tree.md)         | Shared vehicle tree: shared tables under RLS                |
| [0014](0014-catalog-model.md)               | Catalog model                                               |
| [0015](0015-catalog-search.md)              | Catalog search                                              |
| [0016](0016-catalog-import.md)              | Catalog import from spreadsheets                            |
