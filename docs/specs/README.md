# Spec-driven development with parallel work streams

Decision record: [ADR-020](../adr/ADR-020-spec-driven-development-and-parallel-streams.md).

A phase `PLAN.md` states what the phase must achieve. A **spec** refines one coherent capability
inside that plan into requirements, a design with frozen contracts, and tasks. Its work is split into
**work streams** that agents or people build at the same time on separate branches. The streams
then merge into one integration branch, which goes to `main` as a single pull request.

```text
PLAN.md ─┬─ SPEC-001 ── requirements → design (frozen contracts) → tasks + streams.json
         │                 │
         │      spec/001-slug/integration  ← scaffold, then merges in wave order
         │        ├── spec/001-slug/ws-a   (wave 1)
         │        ├── spec/001-slug/ws-b   (wave 1)
         │        └── spec/001-slug/ws-c   (wave 2, after ws-a)
         │                 │
         │      one pull request: integration → main → phase audit
         └─ SPEC-002 …
```

## Layout

```text
docs/phases/phase-NN-name/specs/SPEC-NNN-slug/
  requirements.md   EARS requirements R-NN, each traced to a phase acceptance criterion
  design.md         approach, frozen cross-stream contracts, stream split, scaffold
  tasks.md          tasks per stream, each tied to requirements and tests
  streams.json      machine-readable streams: owned paths, dependencies, migrations, checks
```

Copy [template/](template/) to start. Spec numbers are global across phases.

## Lifecycle

`streams.json` carries the status. `corepack pnpm spec:validate` (part of `verify`) checks every
manifest on every pull request.

| Status        | Meaning                                                                    |
| ------------- | -------------------------------------------------------------------------- |
| `draft`       | Being written on an ordinary branch. No stream branch may start.           |
| `approved`    | Reviewed and merged to `main` or the integration branch. Contracts frozen. |
| `in-progress` | Streams are running.                                                       |
| `integrated`  | Integration branch merged to `main`. Its migration reservations are free.  |

## Workflow

1. **Write the spec.** Use a normal branch and pull request. Review requirements and contracts
   before code exists. Set `status` to `approved` when the review passes.
2. **Scaffold.** On `spec/NNN-slug/integration`, make the changes in design section 4: package
   manifests, lockfile, configuration, module skeletons, and shared contract files.
3. **Start streams.** Run `corepack pnpm spec:start SPEC-NNN-slug`. It creates the integration
   branch if it is missing. It creates a branch and a worktree for every stream whose dependencies
   have merged. Worktrees go to `../Trayvi.worktrees/NNN-slug/ws-x` unless `--worktrees <dir>` is
   given. They stay outside the repository so lint, tests, and scans do not read them twice.
4. **Brief each agent.** Run `corepack pnpm spec:brief SPEC-NNN-slug ws-a` and hand the output to
   the agent working in that worktree. The brief lists the documents to read, the only paths it may
   change, its acceptance criteria, and the checks it must pass.
5. **Check ownership.** Inside a stream worktree, `corepack pnpm spec:check-branch` fails when the
   branch changes a path its stream does not own. CI runs the same check on every pull request into
   a `spec/` branch.
6. **Merge in waves.** Open each stream pull request against the integration branch. Merge in the
   wave order shown by `corepack pnpm spec:status SPEC-NNN-slug`. Use a merge commit (GitHub
   "Create a merge commit", or `git merge --no-ff`). Squash and rebase merges hide which streams
   have merged, so `spec:status` and `spec:start` cannot see them. Run `corepack pnpm verify:full`
   after each merge. Then run `spec:start` again to open the next wave.
7. **Integrate.** Update `tasks.md` and the phase `IMPLEMENTATION.md` on the integration branch.
   Set `status` to `integrated`, then open one pull request to `main`. The phase audit gate is
   unchanged.

## Ownership rules

- An ownership entry is an exact file path or a directory ending in `/`. Globs are rejected, so
  overlap is decided exactly.
- No two streams own overlapping paths.
- Streams never own integration-owned paths: any `package.json`, the lockfile, workspace and tool
  configuration, `.github/`, `docs/adr/README.md`, or the migrations directory.
- A stream may add only the migration files for the numbers reserved in `streams.json`
  (`NNNN_name.up.sql` and `NNNN_name.down.sql`). No two unfinished specs reserve the same number.
- Streams never edit their own spec documents. If a contract is wrong, the agent stops and reports
  it. The spec is corrected through review, and affected streams rebase on the integration branch.

## Agents

Each agent works in exactly one stream worktree. It receives only the brief and the spec documents.
It does not merge, push to the integration branch, or edit another stream. A person, or the
coordinating session, reviews each stream pull request and performs the wave merges.
