# ADR-001 — Modular Monolith and Extraction Criteria

**Status:** Accepted  
**Date:** 2026-09-04  
**Owners:** Trayvi architecture

## Context

Trayvi needs strong transactional boundaries and credible future growth, but has no workload or team
evidence that justifies distributed services.

## Decision drivers

Transactional integrity, low operational complexity, explicit ownership, testability, and reversible
evolution.

## Considered options

- Microservices from inception: rejected because they add network consistency and operational cost.
- One unstructured application: rejected because ownership would be conventional only.
- Modular monolith with independent runtime shells: accepted.

## Decision

Business capabilities will live in explicitly owned modules inside one deployable backend boundary.
Transport and infrastructure depend inward on application/domain ports. The API and worker are
separate processes. A module may be extracted only after ownership is clear and an ADR demonstrates
independent scaling, isolation, deployment, regulatory, or team-ownership need.

## Consequences

Cross-module calls are initially in-process and may share a transaction. Boundaries require automated
import checks and database ownership rules. Extraction remains work, but has named seams and evidence
gates.

## Security/privacy/operational impact

Fewer network trust boundaries exist initially. Compromise isolation is process-level, so least
privilege, authorization, and module table ownership remain mandatory.

## Validation and revisit triggers

Architecture checks must detect forbidden imports. Revisit on measured scaling/isolation needs or
material team/regulatory boundaries.

## References

- [Architecture Vision](../../ARCHITECTURE_VISION.md)
- [Phase 0 Plan](../phases/phase-00-foundation/PLAN.md)
