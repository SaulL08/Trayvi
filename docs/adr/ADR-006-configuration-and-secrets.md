# ADR-006 — Configuration, Secrets, and Environment Validation

**Status:** Accepted  
**Date:** 2026-09-04  
**Owners:** Trayvi architecture and security

## Context

Misconfiguration must fail before traffic, while diagnostics must not reveal credentials.

## Decision drivers

Typed access, fail-closed production defaults, one environment boundary, portability, and redaction.

## Considered options

- Scattered `process.env` reads: rejected.
- Permissive defaults: rejected for production ambiguity.
- One Zod composition boundary returning immutable config: accepted.

## Decision

Only `packages/config/src/environment.ts` reads `process.env`. Callers otherwise supply a raw string
map to the validator. The schema enumerates environments, validates URLs and bounded numeric limits,
requires explicit production CORS origins, rejects known example credentials, and reports field names
and constraints without values. `.env.example` contains placeholders, never working credentials.

## Consequences

Every new setting requires schema, documentation, and tests. Tests can validate arbitrary maps without
mutating global environment state.

## Security/privacy/operational impact

Secret values are excluded from errors and safe config views used by logs. Production secrets belong
in a managed service once hosting is selected.

## Validation and revisit triggers

Unit and process-start tests cover missing, malformed, inconsistent, and production-unsafe values.
Revisit when a deployment configuration provider is selected.

## References

- [Security Principles](../../SECURITY_PRINCIPLES.md)
