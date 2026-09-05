# ADR-005 — Money Representation and Rounding Baseline

**Status:** Accepted  
**Date:** 2026-09-04  
**Owners:** Trayvi product and architecture  
**Implementation:** Financial behavior deferred to Phases 12A/12B

## Context

Future pricing and financial work must not inherit unsafe floating-point or mixed-currency primitives.

## Decision drivers

Exact arithmetic, explicit currency, API safety, reproducibility, and consistency with ADR-018.

## Considered options

- Floating-point amounts: rejected.
- Implicit market currency: rejected for multi-market correctness.
- Signed integer minor units plus ISO 4217: accepted.

## Decision

Represent money as signed integer minor units (`bigint` at application boundaries, normally `BIGINT`
in PostgreSQL) plus an ISO 4217 code. Potentially unsafe JSON integers serialize as decimal strings.
Rounding is explicit, deterministic, and versioned by the owning future phase. Fiat and promotional
books remain separate. Phase 0 adds no wallet, ledger, balance, price, or payment code.

## Consequences

Serialization and arithmetic need deliberate helpers later. Display formatting is never authoritative.

## Security/privacy/operational impact

The model avoids silent precision loss and currency confusion but does not establish custody,
accounting, tax, or regulatory approval.

## Validation and revisit triggers

Phases 6 and 12A must add golden/property tests and specialist review. Revisit on currency exponent or
approved FX requirements.

## References

- [Financial Architecture](../architecture/FINANCIAL_ARCHITECTURE.md)
- [ADR-018](ADR-018-financial-ledger-and-trayvi-balance-model.md)
