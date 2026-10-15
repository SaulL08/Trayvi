import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  integrationBranch,
  mergeWaves,
  ownershipViolations,
  parseBranch,
  parseManifest,
  specBranchPrefix,
  streamBranch,
  validateManifest,
  validateManifestSet,
  type ManifestIssue,
  type SpecManifest,
} from './manifest.js';

const requiredDocuments = ['requirements.md', 'design.md', 'tasks.md'] as const;

interface LoadedSpec {
  readonly manifest: SpecManifest;
  readonly directory: string;
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitSucceeds(args: readonly string[]): boolean {
  try {
    execFileSync('git', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function branchExists(branch: string): boolean {
  return gitSucceeds(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
}

/** Prefers the local branch and falls back to origin, so CI checkouts resolve too. */
function resolveRef(branch: string): string | undefined {
  if (branchExists(branch)) return branch;
  if (gitSucceeds(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])) {
    return `origin/${branch}`;
  }
  return undefined;
}

/**
 * A stream is merged when its tip is reachable from the integration branch but is not on that
 * branch's first-parent chain. A fresh stream branch still points at an integration commit, so plain
 * ancestry would report it as merged. This requires merge commits (`--no-ff`) for stream merges.
 */
function isMerged(branch: string, into: string): boolean {
  const source = resolveRef(branch);
  if (source === undefined || !gitSucceeds(['merge-base', '--is-ancestor', source, into])) {
    return false;
  }
  const tip = git(['rev-parse', source]);
  return !git(['rev-list', '--first-parent', into]).split('\n').includes(tip);
}

export async function loadSpecs(
  root: string,
): Promise<{ readonly specs: readonly LoadedSpec[]; readonly issues: readonly ManifestIssue[] }> {
  const specs: LoadedSpec[] = [];
  const issues: ManifestIssue[] = [];
  const phasesRoot = resolve(root, 'docs/phases');
  if (!existsSync(phasesRoot)) return { specs, issues };

  for (const phase of await readdir(phasesRoot, { withFileTypes: true })) {
    if (!phase.isDirectory()) continue;
    const specsRoot = resolve(phasesRoot, phase.name, 'specs');
    if (!existsSync(specsRoot)) continue;
    for (const entry of await readdir(specsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = resolve(specsRoot, entry.name);
      const source = `${phase.name}/specs/${entry.name}`;
      const manifestPath = resolve(directory, 'streams.json');
      if (!existsSync(manifestPath)) {
        issues.push({ code: 'spec-files', spec: source, detail: 'missing streams.json' });
        continue;
      }
      for (const document of requiredDocuments) {
        if (!existsSync(resolve(directory, document))) {
          issues.push({ code: 'spec-files', spec: source, detail: `missing ${document}` });
        }
      }
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(manifestPath, 'utf8'));
      } catch {
        issues.push({
          code: 'manifest-shape',
          spec: source,
          detail: 'streams.json is not valid JSON',
        });
        continue;
      }
      const parsed = parseManifest(raw, source);
      issues.push(...parsed.issues);
      if (!parsed.manifest) continue;
      issues.push(
        ...validateManifest(parsed.manifest, {
          phaseDirectory: phase.name,
          specDirectory: entry.name,
        }),
      );
      specs.push({ manifest: parsed.manifest, directory });
    }
  }
  issues.push(...validateManifestSet(specs.map((spec) => spec.manifest)));
  return { specs, issues };
}

function findSpec(specs: readonly LoadedSpec[], id: string | undefined): LoadedSpec {
  const spec = specs.find((candidate) => candidate.manifest.spec === id);
  if (!spec)
    throw new Error(
      `Unknown spec "${id ?? ''}". Known: ${specs.map((s) => s.manifest.spec).join(', ') || 'none'}`,
    );
  return spec;
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function streamStates(manifest: SpecManifest) {
  const integration = resolveRef(integrationBranch(manifest.spec));
  return mergeWaves(manifest).flatMap((wave, index) =>
    wave.map((id) => {
      const stream = manifest.streams.find((candidate) => candidate.id === id);
      if (!stream) throw new Error(`Unknown stream ${id}`);
      const branch = streamBranch(manifest.spec, id);
      const merged =
        integration !== undefined &&
        resolveRef(branch) !== undefined &&
        isMerged(branch, integration);
      const ready =
        integration !== undefined &&
        stream.dependsOn.every((dependency) =>
          isMerged(streamBranch(manifest.spec, dependency), integration),
        );
      return {
        stream,
        branch,
        wave: index + 1,
        merged,
        ready,
        exists: resolveRef(branch) !== undefined,
      };
    }),
  );
}

function validate(issues: readonly ManifestIssue[], count: number): void {
  if (issues.length > 0) {
    for (const issue of issues) console.error(`${issue.spec}: [${issue.code}] ${issue.detail}`);
    throw new Error(`Spec validation failed with ${issues.length} issue(s)`);
  }
  console.log(JSON.stringify({ event: 'spec.validated', specs: count }));
}

function status(spec: LoadedSpec): void {
  const { manifest } = spec;
  console.log(
    `${manifest.spec} (${manifest.status}) — integration branch ${integrationBranch(manifest.spec)}`,
  );
  for (const state of streamStates(manifest)) {
    const label = state.merged
      ? 'merged'
      : state.ready
        ? state.exists
          ? 'in progress'
          : 'ready'
        : 'blocked';
    const waiting =
      state.stream.dependsOn.length > 0 ? ` after ${state.stream.dependsOn.join(', ')}` : '';
    console.log(
      `  wave ${state.wave}  ${state.stream.id}  ${label.padEnd(11)}  ${state.branch}${waiting}`,
    );
  }
}

function start(spec: LoadedSpec, worktreeRoot: string): void {
  const { manifest } = spec;
  if (manifest.status !== 'approved' && manifest.status !== 'in-progress') {
    throw new Error(`${manifest.spec} is "${manifest.status}"; streams start only after approval`);
  }
  const integration = integrationBranch(manifest.spec);
  if (!resolveRef(integration)) {
    git(['branch', integration, manifest.base]);
    console.log(`created ${integration} from ${manifest.base}`);
  } else if (!branchExists(integration)) {
    git(['branch', '--track', integration, `origin/${integration}`]);
  }

  const activeWorktrees = git(['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('branch refs/heads/'))
    .map((line) => line.slice('branch refs/heads/'.length));

  for (const state of streamStates(manifest)) {
    if (state.merged || !state.ready) continue;
    if (activeWorktrees.includes(state.branch)) {
      console.log(`${state.stream.id}: worktree already active for ${state.branch}`);
      continue;
    }
    const path = resolve(
      worktreeRoot,
      specBranchPrefix(manifest.spec).slice('spec/'.length),
      state.stream.id,
    );
    if (branchExists(state.branch)) {
      git(['worktree', 'add', path, state.branch]);
    } else {
      git(['worktree', 'add', '-b', state.branch, path, integration]);
    }
    console.log(`${state.stream.id}: ${state.branch} at ${path}`);
  }
}

function checkBranch(specs: readonly LoadedSpec[], branch: string, base: string | undefined): void {
  const parsed = parseBranch(branch);
  if (!parsed || parsed.role === 'integration') {
    console.log(
      JSON.stringify({ event: 'spec.branch.skipped', branch, reason: 'not a stream branch' }),
    );
    return;
  }
  const spec = specs.find(
    (candidate) => specBranchPrefix(candidate.manifest.spec) === parsed.prefix,
  );
  if (!spec) throw new Error(`${branch} does not belong to any spec manifest`);
  const stream = spec.manifest.streams.find((candidate) => candidate.id === parsed.role);
  if (!stream)
    throw new Error(
      `${branch} names stream ${parsed.role}, which ${spec.manifest.spec} does not declare`,
    );

  const compareTo = base ?? resolveRef(integrationBranch(spec.manifest.spec));
  if (!compareTo)
    throw new Error(`Cannot resolve ${integrationBranch(spec.manifest.spec)} to compare against`);
  const changed = git(['diff', '--name-only', '--no-renames', `${compareTo}...HEAD`])
    .split('\n')
    .filter(Boolean);
  const violations = ownershipViolations(stream, changed);
  if (violations.length > 0) {
    for (const path of violations) console.error(`${stream.id} may not change ${path}`);
    throw new Error(`${violations.length} path(s) outside ${stream.id} ownership`);
  }
  console.log(
    JSON.stringify({
      event: 'spec.branch.verified',
      branch,
      stream: stream.id,
      changed: changed.length,
    }),
  );
}

function brief(spec: LoadedSpec, streamId: string | undefined, root: string): void {
  const { manifest } = spec;
  const stream = manifest.streams.find((candidate) => candidate.id === streamId);
  if (!stream) throw new Error(`${manifest.spec} has no stream "${streamId ?? ''}"`);
  const docs = spec.directory.slice(root.length + 1);
  const migrations = stream.migrations.map(
    (number) => `infra/database/migrations/${number}_*.{up,down}.sql`,
  );
  console.log(
    [
      `# ${manifest.spec} / ${stream.id} — ${stream.title}`,
      '',
      `Branch: \`${streamBranch(manifest.spec, stream.id)}\` (from \`${integrationBranch(manifest.spec)}\`)`,
      '',
      'Read first, do not edit:',
      ...['requirements.md', 'design.md', 'tasks.md'].map((name) => `- \`${docs}/${name}\``),
      '',
      'You may change only:',
      ...[...stream.owns, ...migrations].map((path) => `- \`${path}\``),
      '',
      `Acceptance criteria: ${stream.acceptance.join(', ')}`,
      `Tasks: the ${stream.id} section of tasks.md.`,
      '',
      'Before finishing, run and pass:',
      ...stream.verify.map((command) => `- \`${command}\``),
      `- \`corepack pnpm spec:check-branch\``,
      '',
      'If a contract in design.md is wrong or a change is needed outside your paths, stop and report it.',
      'Do not work around the contract, edit shared files, or touch another stream.',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const [command = 'validate', ...args] = process.argv.slice(2);
  const root = resolve(git(['rev-parse', '--show-toplevel']));
  const { specs, issues } = await loadSpecs(root);

  if (command === 'validate') return validate(issues, specs.length);
  if (issues.length > 0) validate(issues, specs.length);

  switch (command) {
    case 'status':
      return status(findSpec(specs, args[0]));
    case 'start': {
      const fallback = resolve(dirname(root), `${basename(root)}.worktrees`);
      return start(findSpec(specs, args[0]), resolve(option(args, '--worktrees') ?? fallback));
    }
    case 'check-branch':
      return checkBranch(
        specs,
        option(args, '--branch') ?? git(['rev-parse', '--abbrev-ref', 'HEAD']),
        option(args, '--base'),
      );
    case 'brief':
      return brief(findSpec(specs, args[0]), args[1], root);
    default:
      throw new Error(
        `Unknown command "${command}". Use validate, status, start, check-branch, or brief.`,
      );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
