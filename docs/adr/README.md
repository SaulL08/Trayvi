# Architecture Decision Records

ADRs preserve the reason behind consequential decisions. They are created as `ADR-NNN-short-title.md` and use the status `Proposed`, `Accepted`, `Deprecated`, or `Superseded by ADR-NNN`.

## Required structure

```text
# ADR-NNN — Title
Status:
Date:
Owners:

## Context
## Decision drivers
## Considered options
## Decision
## Consequences
## Security/privacy/operational impact
## Validation and revisit triggers
## References
```

Accepted ADRs are not rewritten to conceal changed assumptions. A new ADR supersedes the old decision and links both directions. Minor spelling or link fixes are allowed without changing meaning.

## Initial register

|                                                         ADR | Decision                                            | Target phase |
| ----------------------------------------------------------: | --------------------------------------------------- | -----------: |
|           [001](ADR-001-modular-monolith-and-extraction.md) | Modular monolith and extraction criteria            |            0 |
|         [002](ADR-002-monorepo-toolchain-and-boundaries.md) | Monorepo/toolchain and dependency boundaries        |            0 |
|     [003](ADR-003-postgresql-postgis-and-sql-migrations.md) | PostgreSQL/PostGIS and SQL migration strategy       |            0 |
|                 [004](ADR-004-opaque-uuidv7-identifiers.md) | Opaque identifier strategy                          |            0 |
|                      [005](ADR-005-money-representation.md) | Money representation and rounding baseline          |            0 |
|                 [006](ADR-006-configuration-and-secrets.md) | Configuration, secrets, and environment validation  |            0 |
|                [007](ADR-007-api-errors-and-idempotency.md) | API, errors, and idempotency conventions            |            0 |
|                      [008](ADR-008-transactional-outbox.md) | Transactional outbox and integration-event strategy |            0 |
|         [009](ADR-009-observability-redaction-and-audit.md) | Observability, redaction, and audit separation      |            0 |
|          [010](ADR-010-vitest-and-real-database-testing.md) | Test strategy and real-database integration harness |            0 |
|                                                         011 | Account/person identity model                       |            1 |
|                                                         012 | National identity protection and key rotation       |            1 |
|                                                         013 | Authentication/session/recovery strategy            |            2 |
|                                                         014 | RBAC, scope, and emergency access                   |            3 |
|                                                         015 | Geospatial representation and provider abstraction  |            4 |
|                                                         016 | Trip state machine                                  |            7 |
|                                                         017 | Dispatch policy and single-winner concurrency       |            8 |
| [018](ADR-018-financial-ledger-and-trayvi-balance-model.md) | Financial ledger and Trayvi balance model           |          12A |
|      [019](ADR-019-phase-0-audit-remediation-invariants.md) | Phase 0 audit remediation invariants                |            0 |

Numbers are reserved for discoverability; if a decision is removed before creation, the register records it as unused rather than renumbering accepted documents.
