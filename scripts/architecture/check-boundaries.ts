import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import ts from 'typescript';

export interface ArchitectureViolation {
  readonly code: string;
  readonly file: string;
  readonly detail: string;
}

const allowedApps = new Set(['api', 'worker']);
const allowedPackages = new Set(['config', 'observability', 'test-support']);

function normalized(path: string): string {
  return path.split(sep).join('/');
}

async function sourceFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage', '.turbo', '.git'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await sourceFiles(path)));
    } else if (entry.isFile() && path.endsWith('.ts')) {
      output.push(path);
    }
  }
  return output;
}

function importsFrom(source: string, file: string): readonly string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

function hasDirectProcessEnvironmentAccess(source: string, file: string): boolean {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'process' &&
      node.name.text === 'env'
    ) {
      found = true;
      return;
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'process' &&
      node.argumentExpression &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === 'env'
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

export async function inspectArchitectureFiles(
  root: string,
  files: readonly string[],
): Promise<readonly ArchitectureViolation[]> {
  const violations: ArchitectureViolation[] = [];
  for (const absoluteFile of files) {
    const file = normalized(relative(root, absoluteFile));
    const source = await readFile(absoluteFile, 'utf8');
    const isTest = /(^|\/)(test|tests|fixtures)\//u.test(file) || /\.test\.ts$/u.test(file);

    if (
      hasDirectProcessEnvironmentAccess(source, file) &&
      file !== 'packages/config/src/environment.ts' &&
      !isTest
    ) {
      violations.push({
        code: 'DIRECT_ENV_ACCESS',
        file,
        detail: 'Only packages/config/src/environment.ts may read process.env.',
      });
    }
    if (/villa\s+altagracia/iu.test(source) && /^(apps|packages)\//u.test(file)) {
      violations.push({
        code: 'MARKET_HARDCODE',
        file,
        detail: 'Market-specific product behavior is prohibited in Phase 0 source.',
      });
    }

    for (const specifier of importsFrom(source, file)) {
      const resolvedImport = specifier.startsWith('.')
        ? normalized(relative(root, resolve(absoluteFile, '..', specifier)))
        : specifier;
      if (file.startsWith('packages/') && resolvedImport.includes('apps/')) {
        violations.push({
          code: 'FOUNDATION_IMPORTS_APP',
          file,
          detail: `Foundation package imports application boundary: ${specifier}`,
        });
      }
      if (!isTest && specifier === '@trayvi/test-support') {
        violations.push({
          code: 'PRODUCTION_IMPORTS_TEST_SUPPORT',
          file,
          detail: 'Production source may not import @trayvi/test-support.',
        });
      }
      if (
        file.startsWith('packages/config/') &&
        (specifier === '@trayvi/observability' || resolvedImport.includes('packages/observability'))
      ) {
        violations.push({
          code: 'CONFIG_IMPORTS_OBSERVABILITY',
          file,
          detail: 'Configuration must remain independent of observability.',
        });
      }
      if (resolvedImport.includes('trayvi_brand_v2_2_clean')) {
        violations.push({
          code: 'PRODUCTION_IMPORTS_REFERENCE_ASSET',
          file,
          detail: 'Provisional brand references cannot be bundled as application assets.',
        });
      }
    }
  }
  return violations;
}

async function workspaceShapeViolations(root: string): Promise<readonly ArchitectureViolation[]> {
  const violations: ArchitectureViolation[] = [];
  for (const [directory, allowed, code] of [
    ['apps', allowedApps, 'UNAPPROVED_APP'],
    ['packages', allowedPackages, 'UNAPPROVED_PACKAGE'],
  ] as const) {
    const entries = await readdir(resolve(root, directory), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !allowed.has(entry.name)) {
        violations.push({
          code,
          file: `${directory}/${entry.name}`,
          detail: 'Workspace unit is not authorized by the Phase 0 plan.',
        });
      }
    }
  }
  return violations;
}

export async function checkRepositoryArchitecture(
  root = process.cwd(),
): Promise<readonly ArchitectureViolation[]> {
  const candidates = [
    ...(await sourceFiles(resolve(root, 'apps'))),
    ...(await sourceFiles(resolve(root, 'packages'))),
    ...(await sourceFiles(resolve(root, 'scripts'))),
  ].filter((file) => !/(^|\\|\/)(test|tests|fixtures)(\\|\/)/u.test(file));
  return [
    ...(await workspaceShapeViolations(root)),
    ...(await inspectArchitectureFiles(root, candidates)),
  ];
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked.endsWith(resolve('scripts/architecture/check-boundaries.ts'))) {
  void checkRepositoryArchitecture().then((violations) => {
    process.stdout.write(
      `${JSON.stringify({ event: 'architecture.checked', passed: violations.length === 0, violations })}\n`,
    );
    if (violations.length > 0) process.exitCode = 1;
  });
}
