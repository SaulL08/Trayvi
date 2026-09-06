# ADR-019 — Phase 0 Audit Remediation Invariants

**Status:** Accepted  
**Date:** 2026-09-06  
**Owners:** Trayvi architecture and security

## Context

The Phase 0 adversarial audit found that several intended controls were represented by tests or
documentation without being enforced at their real trust boundary. The initial audit remains an
immutable historical record; this ADR records the strengthened contract adopted during remediation.

## Decision drivers

Fail-closed behavior, verifiable database identity, migration integrity, request traceability,
bounded shutdown, safe diagnostic evidence, and reviewable supply-chain decisions.

## Considered options

- Document the findings as residual risk: rejected because the High findings and failed acceptance
  criteria require implementation fixes.
- Narrow the claims to the old tests: rejected because that would preserve exploitable or misleading
  controls.
- Enforce each invariant at its runtime or CI boundary and retain adversarial regressions: accepted.

## Decision

Phase 0 adopts these enforceable invariants:

- API admission stops during shutdown, and a successful stop is logged only after tracked handler
  promises settle; expiry marks the runtime failed and exits non-zero.
- Applied migration history must be an exact prefix of locally paired up/down migrations. Both files
  and their pair checksum are recorded and checked before any operation.
- Staging and production database clients use a typed `verify-full` TLS policy. URL query parameters
  cannot weaken or conflict with that policy.
- Runtime database connections authenticate as a dedicated restricted login with a credential
  distinct from the migrator. Role switching cannot restore administrator privileges.
- Outbox rows satisfy a database-enforced state model, and the ordinary runtime login cannot delete
  outbox evidence.
- Logging never invokes accessors while sanitizing, redacts structured secret assignments embedded in
  text, and attaches immutable normalized IDs to each HTTP request for timeout/error/completion logs.
- Workspace boundaries resolve equivalent package, deep, relative, re-export, dynamic-import, and
  environment-access forms.
- CI retains normalized dependency advisory evidence. High/Critical findings always fail; every
  Moderate finding requires a dated, owned, reviewed disposition. Full-history secret scanning is
  streamed and fails on unexpected Git errors.

## Consequences

Local bootstrap provisions separate credentials and requires fresh storage when the physical runtime
login is first introduced. Migration metadata is stricter and accepts only its controlled legacy
upgrade. Dependency audits may fail for missing governance detail even below the High threshold.

## Security/privacy/operational impact

The changes remove administrator-equivalent runtime sessions, plaintext production database
configurations, silent migration drift, contradictory outbox evidence, secret-bearing error text, and
uncorrelated timeout failures. Sanitized artifacts contain advisory metadata but no registry token,
environment file, certificate, database URL, or secret canary.

## Validation and revisit triggers

The regression suites named in the Phase 0 remediation record are mandatory. Revisit these decisions
when production hosting selects a certificate/secrets provider, when an outbox consumer is activated,
or when CI moves to a different advisory source.

## References

- [Phase 0 adversarial audit](../phases/phase-00-foundation/AUDIT.md)
- [Phase 0 remediation](../phases/phase-00-foundation/REMEDIATION.md)
