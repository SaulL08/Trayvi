import { existsSync } from 'node:fs';
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
const allowedModules = new Set(['accounts', 'identity']);

interface WorkspaceUnit {
  readonly name: string;
  readonly directory: string;
  readonly kind: 'app' | 'package' | 'module';
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

interface ImportAnalysis {
  readonly specifiers: readonly string[];
  readonly unresolvedDynamicImport: boolean;
}

function importsFrom(source: string, file: string): ImportAnalysis {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const staticBindings = new Map<string, ts.Expression>();
  let unresolvedDynamicImport = false;
  const collectBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      staticBindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(sourceFile);
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.arguments.length === 1 && node.arguments[0]) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const specifier = staticString(node.arguments[0], staticBindings);
        if (specifier === undefined) {
          if (isDynamicImport) unresolvedDynamicImport = true;
        } else {
          imports.push(specifier);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { specifiers: imports, unresolvedDynamicImport };
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

function staticString(
  expression: ts.Expression,
  bindings: ReadonlyMap<string, ts.Expression>,
  seen = new Set<string>(),
): string | undefined {
  const candidate = unwrapped(expression);
  if (ts.isStringLiteral(candidate) || ts.isNoSubstitutionTemplateLiteral(candidate))
    return candidate.text;
  if (
    ts.isBinaryExpression(candidate) &&
    candidate.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticString(candidate.left, bindings, seen);
    const right = staticString(candidate.right, bindings, seen);
    return left === undefined || right === undefined ? undefined : `${left}${right}`;
  }
  if (ts.isTemplateExpression(candidate)) {
    let value = candidate.head.text;
    for (const span of candidate.templateSpans) {
      const expressionValue = staticString(span.expression, bindings, seen);
      if (expressionValue === undefined) return undefined;
      value += expressionValue + span.literal.text;
    }
    return value;
  }
  if (ts.isIdentifier(candidate) && !seen.has(candidate.text)) {
    const value = bindings.get(candidate.text);
    if (!value) return undefined;
    const nextSeen = new Set(seen);
    nextSeen.add(candidate.text);
    return staticString(value, bindings, nextSeen);
  }
  return undefined;
}

function propertyName(
  expression: ts.Expression,
  bindings: ReadonlyMap<string, ts.Expression>,
): string | undefined {
  const candidate = unwrapped(expression);
  if (ts.isPropertyAccessExpression(candidate)) return candidate.name.text;
  if (ts.isElementAccessExpression(candidate) && candidate.argumentExpression)
    return staticString(candidate.argumentExpression, bindings);
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
  const staticBindings = new Map<string, ts.Expression>();
  let found = false;

  const collectBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      staticBindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(sourceFile);

  const isAlias = (expression: ts.Expression, aliases: ReadonlySet<string>): boolean => {
    const candidate = unwrapped(expression);
    return ts.isIdentifier(candidate) && aliases.has(candidate.text);
  };
  const isReflectGet = (
    expression: ts.Expression,
    objectMatches: (object: ts.Expression) => boolean,
    expectedProperty: string,
  ): boolean => {
    const candidate = unwrapped(expression);
    if (!ts.isCallExpression(candidate) || candidate.arguments.length < 2) return false;
    const reflectObject = accessedObject(candidate.expression);
    const propertyArgument = candidate.arguments[1];
    return (
      reflectObject !== undefined &&
      isAlias(reflectObject, new Set(['Reflect'])) &&
      propertyName(candidate.expression, staticBindings) === 'get' &&
      candidate.arguments[0] !== undefined &&
      propertyArgument !== undefined &&
      objectMatches(candidate.arguments[0]) &&
      staticString(propertyArgument, staticBindings) === expectedProperty
    );
  };
  const isGlobal = (expression: ts.Expression): boolean => isAlias(expression, globalAliases);
  const isProcess = (expression: ts.Expression): boolean => {
    if (isAlias(expression, processAliases)) return true;
    const object = accessedObject(expression);
    return (
      (propertyName(expression, staticBindings) === 'process' &&
        object !== undefined &&
        isGlobal(object)) ||
      isReflectGet(expression, isGlobal, 'process')
    );
  };
  const isEnvironment = (expression: ts.Expression): boolean => {
    const object = accessedObject(expression);
    return (
      (propertyName(expression, staticBindings) === 'env' &&
        object !== undefined &&
        isProcess(object)) ||
      isReflectGet(expression, isProcess, 'env')
    );
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
      const sourceName = element.propertyName
        ? ts.isComputedPropertyName(element.propertyName)
          ? staticString(element.propertyName.expression, staticBindings)
          : element.propertyName.getText(sourceFile).replaceAll(/["']/gu, '')
        : element.name.getText(sourceFile).replaceAll(/["']/gu, '');
      if (isProcess(initializer) && sourceName === 'env') found = true;
      if (
        isAlias(initializer, globalAliases) &&
        sourceName === 'process' &&
        ts.isIdentifier(element.name)
      ) {
        processAliases.add(element.name.text);
      }
    }
  };

  const bindKnownAliases = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) bindAlias(node.name, node.initializer);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      if (isProcess(node.right)) processAliases.add(node.left.text);
      if (isAlias(node.right, globalAliases)) globalAliases.add(node.left.text);
    }
    ts.forEachChild(node, bindKnownAliases);
  };
  for (let pass = 0; pass < staticBindings.size + 2; pass += 1) {
    const previousSize = processAliases.size + globalAliases.size;
    bindKnownAliases(sourceFile);
    if (processAliases.size + globalAliases.size === previousSize) break;
  }

  const visit = (node: ts.Node): void => {
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
    ['modules', 'module'],
    ['packages', 'package'],
  ] as const) {
    const topLevelDirectory = resolve(root, topLevel);
    if (!existsSync(topLevelDirectory)) continue;
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
  root: string,
  units: readonly WorkspaceUnit[],
): WorkspaceUnit | undefined {
  const textualTarget = specifier.startsWith('.')
    ? owningUnit(resolve(dirname(importer), specifier), units)
    : units.find((unit) => specifier === unit.name || specifier.startsWith(`${unit.name}/`));
  if (textualTarget) return textualTarget;

  let directory = dirname(importer);
  const canonicalRoot = resolve(root);
  let configFile: string | undefined;
  while (directory === canonicalRoot || directory.startsWith(`${canonicalRoot}${sep}`)) {
    const candidate = resolve(directory, 'tsconfig.json');
    if (existsSync(candidate)) {
      configFile = candidate;
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!configFile) return undefined;
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configFile,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => undefined,
    },
  );
  if (!parsed) return undefined;
  const resolvedModule = ts.resolveModuleName(specifier, importer, parsed.options, ts.sys)
    .resolvedModule?.resolvedFileName;
  return resolvedModule ? owningUnit(resolvedModule, units) : undefined;
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
    if (/villa\s+altagracia/iu.test(source) && /^(apps|modules|packages)\//u.test(file)) {
      violations.push({
        code: 'MARKET_HARDCODE',
        file,
        detail: 'Market-specific product behavior is prohibited in Phase 0 source.',
      });
    }

    const importAnalysis = importsFrom(source, file);
    if (
      (importer?.kind === 'package' || importer?.kind === 'module') &&
      importAnalysis.unresolvedDynamicImport
    ) {
      violations.push({
        code: 'UNRESOLVED_FOUNDATION_DYNAMIC_IMPORT',
        file,
        detail: 'Package/module dynamic imports must have a statically resolvable target.',
      });
    }
    for (const specifier of importAnalysis.specifiers) {
      const target = importedUnit(specifier, absoluteFile, root, units);
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
      if (importer?.kind === 'package' && target?.kind === 'module') {
        violations.push({
          code: 'FOUNDATION_IMPORTS_MODULE',
          file,
          detail: `Foundation package imports business module: ${specifier}`,
        });
      }
      if (importer?.kind === 'module' && target?.kind === 'app') {
        violations.push({
          code: 'MODULE_IMPORTS_APP',
          file,
          detail: `Business module imports application boundary: ${specifier}`,
        });
      }
      if (importer?.kind === 'module' && target?.kind === 'module' && target !== importer) {
        violations.push({
          code: 'MODULE_IMPORTS_MODULE',
          file,
          detail: `Business modules collaborate through application ports, not direct imports: ${specifier}`,
        });
      }
      if (
        importer?.kind === 'module' &&
        file.includes('/domain/') &&
        (resolvedImport.includes('/application/') || resolvedImport.includes('/infrastructure/'))
      ) {
        violations.push({
          code: 'DOMAIN_IMPORTS_OUTWARD',
          file,
          detail: `Domain code imports an outward layer: ${specifier}`,
        });
      }
      if (
        importer?.kind === 'module' &&
        file.includes('/application/') &&
        resolvedImport.includes('/infrastructure/')
      ) {
        violations.push({
          code: 'APPLICATION_IMPORTS_INFRASTRUCTURE',
          file,
          detail: `Application code imports infrastructure: ${specifier}`,
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
    ['modules', allowedModules, 'UNAPPROVED_MODULE'],
    ['packages', allowedPackages, 'UNAPPROVED_PACKAGE'],
  ] as const) {
    if (!existsSync(resolve(root, directory))) continue;
    const entries = await readdir(resolve(root, directory), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !allowed.has(entry.name)) {
        violations.push({
          code,
          file: `${directory}/${entry.name}`,
          detail: 'Workspace unit is not authorized by the accepted phase plans.',
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
    if (unit.kind === 'app') continue;
    for (const dependencyName of Object.keys({
      ...(unit.manifest.dependencies ?? {}),
      ...(unit.manifest.devDependencies ?? {}),
    })) {
      const target = units.find((candidate) => candidate.name === dependencyName);
      if (target?.kind === 'app') {
        violations.push({
          code: unit.kind === 'package' ? 'FOUNDATION_DEPENDS_ON_APP' : 'MODULE_DEPENDS_ON_APP',
          file: normalized(relative(root, resolve(unit.directory, 'package.json'))),
          detail: `${unit.kind === 'package' ? 'Foundation package' : 'Business module'} depends on application package: ${dependencyName}`,
        });
      }
      if (unit.kind === 'package' && target?.kind === 'module') {
        violations.push({
          code: 'FOUNDATION_DEPENDS_ON_MODULE',
          file: normalized(relative(root, resolve(unit.directory, 'package.json'))),
          detail: `Foundation package depends on business module: ${dependencyName}`,
        });
      }
      if (unit.kind === 'module' && target?.kind === 'module' && target !== unit) {
        violations.push({
          code: 'MODULE_DEPENDS_ON_MODULE',
          file: normalized(relative(root, resolve(unit.directory, 'package.json'))),
          detail: `Business module depends directly on another business module: ${dependencyName}`,
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
    ...(await sourceFiles(resolve(root, 'modules'))),
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
