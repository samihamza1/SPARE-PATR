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

| #                                         | Decision                           |
| ----------------------------------------- | ---------------------------------- |
| [0001](0001-monorepo-and-tooling.md)      | Monorepo layout and tooling        |
| [0002](0002-api-framework.md)             | API framework: Fastify             |
| [0003](0003-query-layer.md)               | Query layer: Kysely                |
| [0004](0004-migration-tool.md)            | Migration tool: dbmate             |
| [0005](0005-money-representation.md)      | Money representation: decimal.js   |
| [0006](0006-tenant-isolation-with-rls.md) | Tenant isolation with Postgres RLS |
