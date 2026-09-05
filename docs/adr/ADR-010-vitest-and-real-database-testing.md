# ADR-010 — Vitest and Real-Database Integration Testing

**Status:** Accepted  
**Date:** 2026-09-04  
**Owners:** Trayvi architecture

## Context

Phase 0 needs fast strict-TypeScript tests and credible evidence for PostgreSQL/PostGIS, migrations,
process lifecycle, and failure behavior on Windows and Linux.

## Decision drivers

TypeScript support, isolation, coverage, watch speed, Nest compatibility, IDE debugging, real service
support, and maintainability.

## Considered options

- Jest: mature Nest defaults, but requires more TypeScript transform/configuration and slower startup.
- Vitest: native modern TypeScript/Vite pipeline, workspace projects, fast watch, Jest-like assertions.
- Node test runner: minimal, but weaker mocking/coverage ergonomics for this repository.

## Decision

Use Vitest with separate `unit` and `integration` projects. Unit tests require no external service.
Integration tests use a real pinned PostgreSQL/PostGIS container and isolated disposable databases;
SQLite/in-memory substitutes are prohibited for database invariants. Coverage is diagnostic rather
than a substitute for named behavioral tests.

## Consequences

Nest examples often assume Jest, so project helpers remain explicit and small. Developers need Docker
for the full suite but not for unit/static work.

## Security/privacy/operational impact

Fixtures use generated, non-production values. Failure output and retained artifacts pass the same
secret constraints as runtime logs.

## Validation and revisit triggers

Windows and Linux CI run the suites. Revisit if maintenance health, Nest compatibility, isolation, or
measured runtime materially regresses.

## References

- [Phase 0 Plan](../phases/phase-00-foundation/PLAN.md)
