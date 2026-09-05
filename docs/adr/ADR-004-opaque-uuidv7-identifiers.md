# ADR-004 — Opaque UUIDv7 Identifiers

**Status:** Accepted  
**Date:** 2026-09-04  
**Owners:** Trayvi architecture

## Context

Identifiers must not reveal official documents, contacts, sequence counts, or market assumptions.

## Decision drivers

Opacity, distributed generation, database index locality, interoperability, and safe logging.

## Considered options

- Sequential integers: rejected for public enumeration and extraction friction.
- User attributes: prohibited because they disclose restricted/confidential data.
- Random UUIDv4 only: acceptable opacity but poorer insertion locality.
- UUIDv7: accepted.

## Decision

Generate UUIDv7 identifiers centrally through an injectable `IdGenerator`; use operating-system
cryptographic randomness. Inbound request/correlation identifiers are accepted only if they are
canonical UUIDs within a fixed length; otherwise they are replaced. IDs are identifiers, never
authorization evidence.

## Consequences

Opaque IDs are larger than integers and require validation. Deterministic generators are injected in
tests rather than weakening production randomness.

## Security/privacy/operational impact

Personal data cannot be used as an ID. Logs and events may contain approved opaque IDs but never raw
documents, phone numbers, or emails.

## Validation and revisit triggers

Tests cover version/format, replacement of malformed/control-character inputs, and propagation.
Revisit only if platform-native UUIDv7 changes compatibility or a stronger privacy requirement arises.

## References

- [Security Principles](../../SECURITY_PRINCIPLES.md)
