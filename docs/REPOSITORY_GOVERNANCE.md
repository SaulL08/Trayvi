# Repository governance — Phase 0 checkpoint

## Interim licensing decision

Repository licensing status: **PROPRIETARY / ALL RIGHTS RESERVED — pending legal finalization.**
This is the owner's explicit direction for the repository-closure task, not an inferred OSS choice.
See [LICENSE.md](../LICENSE.md). Legal finalization and the legal rights-holder designation remain
outside this engineering checkpoint.

## Ownership

The default branch is `main`; `.gitattributes` normalizes versioned text to LF.
Git's existing author configuration identifies commits only. It is not evidence of a GitHub
account, repository administrator, or authorized review team.

`.github/CODEOWNERS` is deliberately pending: no confirmed GitHub user/team with repository
access has been supplied. Once confirmed, establish a default reviewer for all paths and
explicit ownership for workflow, security, infrastructure and architecture changes as the team
grows. Never insert placeholder accounts. Review requirements must remain usable by the actual team.

## Remote and hosted enforcement

Current remote status: `REMOTE_REQUIRED`. No remote URL, push, Actions run or enforced branch
protection is claimed. Missing repository coordinates are not a verified permission denial.

After an authorized GitHub remote is supplied:

1. Inspect its default branch and history; do not overwrite unexpected remote work or force-push.
2. Push the reviewed checkpoint without force and observe `.github/workflows/phase-00.yml` on
   `ubuntu-24.04`, checking the exact commit and all mandatory jobs.
3. Require the observed `Phase 0 required gate` check for merges to `main`. It depends on quality,
   integration and security. Require checks to be current for the proposed merge.
4. Enforce pull-request review by the confirmed owners once ownership is configured; prohibit
   ordinary force pushes and branch deletion, and document any administrative bypass policy.
5. Retain evidence of the effective repository rules and their scope. Report
   `BLOCKED_BY_REPOSITORY_PERMISSION` only if an actual permissions check denies the operation.

## Evidence and retention

The workflow configures `phase-00-quality` (quality log, unit JSON and coverage),
`phase-00-integration` (integration JSON/log and database verification log), and
`phase-00-security` (secret, dependency-audit, license and Trivy reports), each for 14 days.
These are configured names and retention, not evidence that GitHub has published them.
Remote closure must record actual run/commit/artifact IDs, inspect downloaded content for secrets,
and verify retention and association with the tested commit.

`pnpm audit --audit-level high` remains a mandatory hosted security step. Its real hosted result
is pending; previous local Trivy evidence is retained separately and does not substitute for it.
TLS verification stays enabled; personal credentials, temporary certificates, exported images,
dependency directories, environment files, build outputs and raw local logs are not versioned.

## Stage boundaries

AC-035 and AC-036 are `PENDING AUDIT`, not implementation defects. The checkpoint does not
authorize an adversarial audit, Phase 1, a product feature, deployment, or a pilot.
