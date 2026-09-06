import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

export interface ArchitectureViolation {
  readonly code: string;
  readonly file: string;
  readonly detail: string;
}

const allowedApps = new Set(['api', 'worker']);
const allowedPackages = new Set(['config', 'observability', 'test-support']);

interface WorkspaceUnit {
  readonly name: string;
  readonly directory: string;
  readonly kind: 'app' | 'package';
  readonly manifest: {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  };
}

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

function unwrapped(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(expression: ts.Expression): string | undefined {
  const candidate = unwrapped(expression);
  if (ts.isPropertyAccessExpression(candidate)) return candidate.name.text;
  if (
    ts.isElementAccessExpression(candidate) &&
    candidate.argumentExpression &&
    (ts.isStringLiteral(candidate.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(candidate.argumentExpression))
  ) {
    return candidate.argumentExpression.text;
  }
  return undefined;
}

function accessedObject(expression: ts.Expression): ts.Expression | undefined {
  const candidate = unwrapped(expression);
  return ts.isPropertyAccessExpression(candidate) || ts.isElementAccessExpression(candidate)
    ? candidate.expression
    : undefined;
}

function hasProcessEnvironmentAccess(source: string, file: string): boolean {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const processAliases = new Set(['process']);
  const globalAliases = new Set(['globalThis', 'global']);
  let found = false;

  const isAlias = (expression: ts.Expression, aliases: ReadonlySet<string>): boolean => {
    const candidate = unwrapped(expression);
    return ts.isIdentifier(candidate) && aliases.has(candidate.text);
  };
  const isProcess = (expression: ts.Expression): boolean => {
    if (isAlias(expression, processAliases)) return true;
    const object = accessedObject(expression);
    return (
      propertyName(expression) === 'process' &&
      object !== undefined &&
      isAlias(object, globalAliases)
    );
  };
  const isEnvironment = (expression: ts.Expression): boolean => {
    const object = accessedObject(expression);
    return propertyName(expression) === 'env' && object !== undefined && isProcess(object);
  };
  const bindAlias = (name: ts.BindingName, initializer: ts.Expression): void => {
    if (ts.isIdentifier(name)) {
      if (isProcess(initializer)) processAliases.add(name.text);
      if (isAlias(initializer, globalAliases)) globalAliases.add(name.text);
      if (isEnvironment(initializer)) found = true;
      return;
    }
    if (!ts.isObjectBindingPattern(name)) return;
    for (const element of name.elements) {
      const sourceName =
        element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile);
      if (isProcess(initializer) && sourceName.replaceAll(/["']/gu, '') === 'env') found = true;
      if (
        isAlias(initializer, globalAliases) &&
        sourceName.replaceAll(/["']/gu, '') === 'process' &&
        ts.isIdentifier(element.name)
      ) {
        processAliases.add(element.name.text);
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) bindAlias(node.name, node.initializer);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      if (isProcess(node.right)) processAliases.add(node.left.text);
      if (isAlias(node.right, globalAliases)) globalAliases.add(node.left.text);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (isEnvironment(node)) found = true;
    }
    if (found) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

async function workspaceUnits(root: string): Promise<readonly WorkspaceUnit[]> {
  const units: WorkspaceUnit[] = [];
  for (const [topLevel, kind] of [
    ['apps', 'app'],
    ['packages', 'package'],
  ] as const) {
    const topLevelDirectory = resolve(root, topLevel);
    for (const entry of await readdir(topLevelDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = resolve(topLevelDirectory, entry.name);
      const manifest = JSON.parse(
        await readFile(resolve(directory, 'package.json'), 'utf8'),
      ) as WorkspaceUnit['manifest'] & {
        readonly name?: unknown;
      };
      if (typeof manifest.name !== 'string')
        throw new Error(`${topLevel}/${entry.name}/package.json has no package name.`);
      units.push({ name: manifest.name, directory, kind, manifest });
    }
  }
  return units;
}

function owningUnit(file: string, units: readonly WorkspaceUnit[]): WorkspaceUnit | undefined {
  const canonical = `${resolve(file)}${sep}`;
  return units.find((unit) => canonical.startsWith(`${resolve(unit.directory)}${sep}`));
}

function importedUnit(
  specifier: string,
  importer: string,
  units: readonly WorkspaceUnit[],
): WorkspaceUnit | undefined {
  if (specifier.startsWith('.')) return owningUnit(resolve(dirname(importer), specifier), units);
  return units.find((unit) => specifier === unit.name || specifier.startsWith(`${unit.name}/`));
}

export async function inspectArchitectureFiles(
  root: string,
  files: readonly string[],
): Promise<readonly ArchitectureViolation[]> {
  const violations: ArchitectureViolation[] = [];
  const units = await workspaceUnits(root);
  for (const absoluteFile of files) {
    const file = normalized(relative(root, absoluteFile));
    const source = await readFile(absoluteFile, 'utf8');
    const isTest = /(^|\/)(test|tests|fixtures)\//u.test(file) || /\.test\.ts$/u.test(file);
    const importer = owningUnit(absoluteFile, units);

    if (
      hasProcessEnvironmentAccess(source, file) &&
      file !== 'packages/config/src/environment.ts'
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
      const target = importedUnit(specifier, absoluteFile, units);
      const resolvedImport = specifier.startsWith('.')
        ? normalized(relative(root, resolve(dirname(absoluteFile), specifier)))
        : specifier;
      if (importer?.kind === 'package' && target?.kind === 'app') {
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

export async function inspectWorkspacePackageGraph(
  root: string,
): Promise<readonly ArchitectureViolation[]> {
  const units = await workspaceUnits(root);
  const violations: ArchitectureViolation[] = [];
  for (const unit of units) {
    if (unit.kind !== 'package') continue;
    for (const dependencyName of Object.keys({
      ...(unit.manifest.dependencies ?? {}),
      ...(unit.manifest.devDependencies ?? {}),
    })) {
      const target = units.find((candidate) => candidate.name === dependencyName);
      if (target?.kind === 'app') {
        violations.push({
          code: 'FOUNDATION_DEPENDS_ON_APP',
          file: normalized(relative(root, resolve(unit.directory, 'package.json'))),
          detail: `Foundation package depends on application package: ${dependencyName}`,
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
    ...(await inspectWorkspacePackageGraph(root)),
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
