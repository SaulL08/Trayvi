# ADR-020 — Spec-Driven Development and Parallel Work Streams

**Status:** Proposed  
**Date:** 2026-10-15  
**Owners:** Trayvi architecture

## Context

Each phase already has a `PLAN.md` that acts as its contract, followed by implementation, audit, and
remediation. A phase plan is too coarse to hand directly to an implementer. Phase 1 went from a
926-line plan to one implementation commit, so the requirement-to-code trace was rebuilt after the
fact in `IMPLEMENTATION.md`.

The team wants several agents to build one capability at the same time. Concurrent work on one
branch, or on branches without agreed boundaries, produces conflicting edits. The repository makes
some of these conflicts costly: migrations are ordered and immutable, the lockfile is shared, and
module boundaries are enforced.

## Decision drivers

- Requirements and cross-module contracts are reviewed before code exists.
- Every requirement traces to a phase acceptance criterion and to a test.
- Parallel work cannot collide on files, migration numbers, or contracts.
- Rules are checked by tooling in CI, not only by convention.
- The existing phase gate and the adversarial audit stay unchanged.

## Considered options

- Keep phase plans only: rejected, because it gives no unit small enough to parallelize or trace.
- Adopt an external spec tool (for example GitHub Spec Kit): rejected for now. It adds a directory
  convention and agent commands, but it does not know this repository's ownership, migration, or
  audit rules. It would also need a new dependency review.
- Specs in the repository with a validated work-stream manifest and branch-ownership check:
  accepted.

## Decision

- A phase is delivered through one or more specs at
  `docs/phases/<phase>/specs/SPEC-NNN-slug/`. Each spec has `requirements.md`, `design.md`,
  `tasks.md`, and `streams.json`. Spec numbers are global.
- Requirements use EARS phrasing, have stable `R-NN` ids, and trace to phase acceptance criteria.
- `design.md` defines every contract that crosses streams. The contracts are frozen when the spec
  becomes `approved`. Streams may start only from an `approved` or `in-progress` spec.
- `streams.json` declares each stream's owned paths, dependencies, reserved migration numbers,
  acceptance criteria, and verification commands. Owned paths are exact files or directories, never
  globs, and no two streams overlap.
- Shared files are integration-owned: package manifests, the lockfile, workspace and tool
  configuration, CI, the ADR register, and the migrations directory. A stream may add only the
  migration files for its reserved numbers.
- Branches are `spec/NNN-slug/integration` and `spec/NNN-slug/ws-x`. The bare `spec/NNN-slug` name
  is never used, because Git cannot store it next to the nested names.
- Streams start from the integration branch once their dependencies have merged into it, and merge
  back in dependency waves through merge commits, never squash or rebase merges. Stream merge
  state is read from Git history. `verify:full` runs after each merge. The integration branch reaches
  `main` as one pull request and then follows the existing phase gate.
- `scripts/spec/spec.ts` implements `validate`, `status`, `start`, `check-branch`, and `brief`.
  `validate` is part of `verify`. CI runs `check-branch` on every pull request into a `spec/` branch.

## Consequences

Small changes that are not part of a phase capability, such as dependency pins and CI fixes, keep
the existing branch flow; a spec is required for phase capabilities. Writing a spec and its scaffold
takes time before code starts. In return, parallel streams cannot silently edit each other's files.
A contract change after approval forces a review and a rebase of affected streams. That cost is
intended.

## Security/privacy/operational impact

The integration branch, not individual streams, owns changes to dependencies, CI, and database
roles shared by many modules, so these changes get one focused review. The ownership check uses
`git diff` names only and reads no file contents. Worktrees are created outside the repository, so
secret scans, lint, and tests do not read duplicate trees.

## Validation and revisit triggers

Unit tests cover manifest validation, dependency waves, and ownership decisions. Revisit when:

- streams regularly need paths owned by others (the split is wrong, or ownership needs finer rules);
- the integration scaffold becomes a bottleneck;
- an external spec tool can enforce these rules;
- remote hosting gains branch rules that can enforce ownership natively.

## References

- [docs/specs/README.md](../specs/README.md)
- [IMPLEMENTATION_ROADMAP.md](../../IMPLEMENTATION_ROADMAP.md)
- [ADR-002](ADR-002-monorepo-toolchain-and-boundaries.md),
  [ADR-003](ADR-003-postgresql-postgis-and-sql-migrations.md)
