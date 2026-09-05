# ADR-007 — HTTP API, Safe Errors, and Idempotency Conventions

**Status:** Accepted  
**Date:** 2026-09-04  
**Owners:** Trayvi architecture

## Context

HTTP behavior needs a stable, safe convention before product endpoints exist.

## Decision drivers

Compatibility, predictable clients, privacy-safe failures, bounded input, and safe retries.

## Considered options

- Framework-default errors: rejected because shape and exposure are inconsistent.
- Unversioned endpoints: rejected.
- `/api/v1` plus Problem Details semantics: accepted.

## Decision

Product APIs use `/api/v1`, camelCase JSON, explicit schemas, and rejection of unknown command fields.
Errors use `application/problem+json` with stable `type`, `title`, `status`, `code`, and `requestId`;
safe violations are optional. Stack, SQL, paths, config, and raw input never leave the API. Retryable
future creation commands require principal-and-operation-scoped idempotency keys whose request hash
and result commit with the mutation.

## Consequences

Controllers map transport only. Future OpenAPI is generated when a real public contract exists; Phase
0 health endpoints alone do not justify a contract package.

## Security/privacy/operational impact

Body, URL, header, and timeout limits are explicit. Query/body logging is off. CORS is an allowlist.

## Validation and revisit triggers

Tests cover unknown errors, malformed/oversized input, headers, CORS, and request IDs. Revisit with the
first product command/API contract.

## References

- [Architecture Vision](../../ARCHITECTURE_VISION.md)
