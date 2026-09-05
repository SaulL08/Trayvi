# ADR-002 — Monorepo Toolchain and Dependency Boundaries

**Status:** Accepted  
**Date:** 2026-09-04  
**Owners:** Trayvi architecture

## Context

Phase 0 needs deterministic TypeScript builds for API, worker, and narrowly scoped foundation code on
Windows development and Linux CI.

## Decision drivers

Reproducibility, explicit task dependencies, fast local checks, no required global install, and
machine-enforced ownership.

## Considered options

- Separate repositories: rejected before independent ownership/deployment evidence.
- npm workspaces alone: workable, but weaker workspace filtering and content-addressed installation.
- pnpm workspaces plus Turborepo: accepted.

## Decision

Use Node `22.14.0`, pnpm `11.25.0` through Corepack, pnpm workspaces, Turborepo, strict TypeScript,
ESLint, and Prettier. Exact dependency versions and integrity are recorded by `pnpm-lock.yaml`.
Applications may depend on foundation packages; foundation packages cannot depend on applications;
production code cannot import test support.

## Consequences

Developers need pinned Node and Corepack, but no global pnpm. Root scripts are the supported interface.
Custom architecture checks complement package-manager isolation.

## Security/privacy/operational impact

Frozen installs, reviewed lifecycle builds, minimal CI permissions, and lockfile-based caching reduce
supply-chain drift. A lockfile is necessary evidence, not proof that dependencies are safe.

## Validation and revisit triggers

CI verifies tool versions, frozen install, boundaries, lint, types, tests, and builds. Revisit when Node
22 leaves support or the workspace graph materially changes.

## References

- [Architecture Vision](../../ARCHITECTURE_VISION.md)
- [Phase 0 Plan](../phases/phase-00-foundation/PLAN.md)
