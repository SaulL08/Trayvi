# ADR-003 — PostgreSQL/PostGIS and Reviewed SQL Migrations

**Status:** Accepted  
**Date:** 2026-09-04  
**Owners:** Trayvi architecture

## Context

Trayvi requires transactions, constraints, concurrency controls, and later geospatial operations. Its
critical schema must remain directly reviewable.

## Decision drivers

Data integrity, PostGIS support, deterministic migration behavior, least privilege, and operational
clarity.

## Considered options

- SQLite/in-memory substitutes: rejected because they cannot prove PostgreSQL behavior.
- ORM schema synchronization: rejected as an opaque and unsafe production migration authority.
- PostgreSQL/PostGIS with reviewed SQL and a small runner: accepted.

## Decision

Use PostgreSQL 17 with PostGIS 3.5 through the minimal hardened image defined in
`infra/database/Dockerfile.postgis`: its upstream Alpine base is pinned by digest, the known-vulnerable
`libexpat` revision is upgraded to its fixed package revision, and vulnerable Go-based `gosu` is
replaced by Alpine's fixed-version `su-exec` compatible helper. The shipped image declares UID/GID 70
as its runtime identity; fresh named volumes inherit the image directory ownership, so neither the
entrypoint nor PostgreSQL starts as root. The final stage copies the resulting root filesystem into
`scratch` so the removed binary does not remain detectable in a lower shipped layer. Store paired
immutable `*.up.sql` and `*.down.sql` migrations in `infra/database/migrations`. The runner verifies
SHA-256 checksums, takes a session advisory lock, applies each migration transactionally, and records
only successful versions. Production uses distinct migration and runtime roles; runtime has no DDL.
API/worker startup never runs migrations.

## Consequences

SQL changes require explicit rollback/roll-forward analysis. The repository owns a small runner rather
than a broad ORM migration dependency.

## Security/privacy/operational impact

Connection URLs are secret config. Schema privileges are allowlisted. Advisory locking prevents two
deployments from applying the same change concurrently.

## Validation and revisit triggers

Real-database tests cover empty/repeat/down/up/failure/concurrency, PostGIS availability, and runtime
DDL denial. Revisit on PostgreSQL support lifecycle or migration-scale evidence.

## References

- [Phase 0 Plan](../phases/phase-00-foundation/PLAN.md)
