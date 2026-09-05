# ADR-009 — Observability, Redaction, and Audit Separation

**Status:** Accepted  
**Date:** 2026-09-04  
**Owners:** Trayvi architecture and security

## Context

Operators need correlated evidence without turning telemetry into a second sensitive-data store.

## Decision drivers

Structured diagnosis, vendor neutrality, recursive leak prevention, bounded cardinality, and truthful
health.

## Considered options

- Free-form console logs: rejected.
- Full request/response capture: rejected as disproportionate exposure.
- Structured Pino logs, Prometheus-compatible metrics, OpenTelemetry hooks, and central redaction:
  accepted.

## Decision

Every log passes a final recursive, case-insensitive sanitizer covering secrets, identity/payment
fields, arrays, errors, headers, bearer/JWT-like strings, control characters, and URL query values.
Baseline fields are timestamp, level, service, environment, version, event, outcome, duration, and
request/correlation/trace IDs where applicable. Metrics use allowlisted low-cardinality labels.
Tracing/export is optional and failure cannot crash readiness. Application logs, integration events,
and future append-oriented audit evidence remain distinct records.

## Consequences

Some diagnostic detail is intentionally excluded from general telemetry. Restricted evidence later
needs its own access and retention channel.

## Security/privacy/operational impact

HTTP bodies and query values are never logged. Health reports fixed component status only. Exporters
use bounded timeouts and sanitized failures.

## Validation and revisit triggers

The redaction corpus and telemetry-failure tests are mandatory. Revisit with a selected production
observability provider or new restricted data class.

## References

- [Security Principles](../../SECURITY_PRINCIPLES.md)
