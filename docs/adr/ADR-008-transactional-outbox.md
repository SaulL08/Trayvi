# ADR-008 — Transactional Outbox and Integration Events

**Status:** Accepted  
**Date:** 2026-09-04  
**Owners:** Trayvi architecture

## Context

Future asynchronous effects must not be lost between a committed database change and publication.
There is no Phase 0 workload that justifies a broker.

## Decision drivers

Atomic persistence, at-least-once delivery, idempotency, privacy-safe events, and low initial operations.

## Considered options

- Direct publish after commit: rejected because crashes lose events.
- Distributed transaction: rejected as unnecessary and poorly supported.
- PostgreSQL outbox with a worker: accepted.

## Decision

A minimal technical `platform.outbox_events` table stores UUIDv7-compatible event IDs, type/schema
version, aggregate reference, UTC occurrence time, correlation/causation IDs, non-sensitive JSON
payload, availability/attempt/claim/publication state, and safe error code. A business mutation and its
event insert share one caller-owned transaction. Delivery is at least once; consumers are idempotent.
The Phase 0 worker has lifecycle infrastructure only and publishes nothing. No broker is added.

The database permits only this foundation state machine:

```text
insert -> pending
pending -> processing -> published
                      -> failed -> processing
```

Claiming `pending` or `failed` increments `attempts`, sets both lock fields, and clears publication
and error fields. Completing `processing` preserves `attempts`, clears both lock fields, and sets
exactly one terminal outcome: `published_at` for `published`, or a safe `last_error_code` for
`failed`. Published rows are terminal. A database trigger enforces these transitions even when a
runtime bug issues direct DML; row constraints independently enforce each state's field shape.

## Consequences

Polling, retry, dead-letter policy, and broker adapters remain future work. The table is justified by a
real PostgreSQL atomicity/constraint integration test.

## Security/privacy/operational impact

Payloads exclude restricted data. Metrics use bounded event categories, not aggregate/user IDs.

## Validation and revisit triggers

Integration tests prove commit/rollback atomicity, state shapes, allowed transitions, denied skips,
terminal publication, and runtime DELETE denial. Revisit when the first real event consumer needs
throughput or isolation beyond PostgreSQL polling.

## References

- [Architecture Vision](../../ARCHITECTURE_VISION.md)
