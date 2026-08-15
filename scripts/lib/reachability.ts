/**
 * Production-reachability analysis for the monorepo.
 *
 * The repo's most repeated defect is code that is written, exported and unit
 * tested, but that no production code path ever reaches — a circuit breaker
 * nobody wired, an admission controller nobody admitted through, a guard
 * nobody guarded with. The dependency-rule checker cannot see this class of
 * defect: it inspects the edges that exist, and this defect is the *absence*
 * of an edge.
 *
 * This module answers "who calls this in production?" by walking the module
 * graph twice — once from the real application entrypoints, once from the test
 * files — and classifying every exported value:
 *
 * - `live`      — a production entrypoint reaches it.
 * - `test-only` — only tests reach it. This is the defect shape: built,
 *                 covered, and unreachable by users.
 * - `unreferenced` — nothing names it at all.
 *
 * Liveness of *files* is propagated coarsely (any named import from a live
 * module makes the target module live), while liveness of *exports* requires a
 * consumer to actually name the symbol. That asymmetry is deliberate: it
 * over-approximates what is alive, so the checker under-reports rather than
 * accuses working code.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const SCOPE_PREFIX = "@tulipfarm/";
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  ".turbo",
  ".vitest-reports",
  ".react-router",
  ".source",
  "public",
]);

/** How an exported name is produced by the module that exports it. */
type ExportSource =
  | { kind: "local"; isType: boolean }
  | { kind: "reexport"; specifier: string; sourceName: string; isType: boolean };

interface ImportRecord {
  specifier: string;
  /** Exported name on the far side; `*` means a namespace or dynamic import. */
  sourceName: string;
  /** Local binding introduced here, if any. Absent for side-effect imports. */
  local?: string;
  isType: boolean;
}

interface ModuleRecord {
  file: string;
  exports: Map<string, ExportSource>;
  /** Specifiers re-exported wholesale via `export * from`. */
  starReexports: string[];
  imports: ImportRecord[];
  /** How often each identifier appears outside of an import clause. */
  referenced: Map<string, number>;
  /** True when the module body does something other than declare and export. */
  hasSideEffects: boolean;
  /**
   * String literals appearing inside a `new Worker(...)` argument. A worker
   * thread's entry module is named at runtime, so nothing imports it and the
   * graph would call it dead — see {@link workerThreadRoots}.
   */
  workerSpecifiers: string[];
  /**
   * Public methods of exported classes, by declaring class. Methods are not
   * module exports, so the export graph never sees them — yet a cleanup method
   * nothing calls is the same defect wearing a different hat.
   */
  classMethods: Array<{ className: string; method: string }>;
  /** Member names used as `x.name`, which is how a method call is spelled. */
  memberReferences: Set<string>;
}

export type Reachability = "unreferenced" | "test-only";

export interface ExportFinding {
  /** Repo-relative path of the module that declares the export. */
  file: string;
  name: string;
  reachability: Reachability;
}

export interface MethodFinding {
  /** Repo-relative path of the module declaring the class. */
  file: string;
  className: string;
  method: string;
}

export interface ReachabilityReport {
  /** Exported values that no production code path executes. */
  findings: ExportFinding[];
  /** Repo-relative paths of modules no production entrypoint loads. */
  deadModules: string[];
  /**
   * Exports that production does execute, but only from inside their own
   * module. Not a reachability defect — an export-surface smell — so this is
   * reported and not enforced.
   */
  overExported: Array<{ file: string; name: string }>;
  /**
   * Public methods of production-live classes that no production module even
   * names. The export graph cannot see these — a class is one export however
   * many operations it carries — yet "a cleanup method with no production
   * consumer" is the same defect, and was the shape of several instances.
   */
  deadMethods: MethodFinding[];
  /** Entrypoints the walk started from, for diagnosis. */
  roots: string[];
  scannedFiles: number;
}

/**
 * Exports consumed by a framework rather than by repo code. A Remix route's
 * `loader` has no in-repo caller by design, and flagging it would train
 * readers to ignore this checker.
 */
/**
 * Methods the language or a protocol calls, never repo code. `JSON.stringify`
 * reaches `toJSON`, `for await` reaches `[Symbol.asyncIterator]`, and `using`
 * reaches `dispose` — none has, or should have, a named caller.
 */
const PROTOCOL_METHODS = new Set([
  "toJSON",
  "toString",
  "valueOf",
  "dispose",
  "asyncDispose",
  "then",
  "catch",
  "finally",
]);

const FRAMEWORK_EXPORTS = new Set([
  "default",
  "loader",
  "action",
  "meta",
  "links",
  "headers",
  "handle",
  "shouldRevalidate",
  "ErrorBoundary",
  "HydrateFallback",
  "clientLoader",
  "clientAction",
  "config",
  "generateMetadata",
  "generateStaticParams",
  "metadata",
  "viewport",
  "revalidate",
  "dynamic",
  "runtime",
]);

export function isTestFile(relPath: string): boolean {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(relPath) ||
    /(^|\/)(test|tests|__tests__|__fixtures__|e2e)\//.test(relPath) ||
    /(^|\/)(vitest|playwright)\.[^/]*$/.test(relPath)
  );
}

/**
 * Modules whose whole purpose is to support tests. Being reachable only from
 * tests is their contract, not a defect, so their exports are not findings —
 * but a test-support module nothing references at all still fails, because
 * that is dead code by any measure.
 */
export function isTestSupportFile(relPath: string): boolean {
  return (
    /^packages\/testkit\//.test(relPath) ||
    /(^|\/)test-(doubles|fixtures|support|helpers)\.[cm]?tsx?$/.test(relPath) ||
    /(^|\/)testing\//.test(relPath)
  );
}

/**
 * Modules the runtime loads without any repo file importing them. These are
 * derived from each workspace's `package.json` — the scripts that actually
 * start a process, plus the `bin` entries — and from the two file-routing
 * conventions in use (Remix's `app/routes`, Next's `app`). Guessing them by
 * filename would be wrong in both directions: `apps/worker/src/index.ts`
 * looks like an entrypoint and is really a test-only barrel.
 */
function discoverRoots(root: string, workspaceDirs: Map<string, string>): Set<string> {
  const roots = new Set<string>();
  const add = (file: string | undefined) => {
    if (file) roots.add(file);
  };

  for (const dir of workspaceDirs.values()) {
    let manifest: { scripts?: Record<string, string>; bin?: string | Record<string, string> };
    try {
      manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }

    for (const command of Object.values(manifest.scripts ?? {})) {
      for (const token of command.match(/[\w./@-]+\.[cm]?tsx?\b/g) ?? []) {
        add(resolveFileish(path.resolve(dir, token)));
      }
    }
    const bin = manifest.bin;
    for (const entry of typeof bin === "string" ? [bin] : Object.values(bin ?? {})) {
      add(resolveFileish(path.resolve(dir, entry)));
    }

    // Build-tool configuration at the workspace root is loaded by the tool.
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      // Workspace vanished between discovery and read; nothing to add.
    }
    for (const entry of entries) {
      if (/\.config\.[cm]?tsx?$/.test(entry) && !/vitest/.test(entry)) {
        add(path.join(dir, entry));
      }
    }

    // Remix: `app/routes/**` plus the three well-known entry modules.
    const appDir = path.join(dir, "app");
    for (const name of ["root.tsx", "entry.client.tsx", "entry.server.tsx"]) {
      const file = path.join(appDir, name);
      if (exists(file)) add(file);
    }
    const routesDir = path.join(appDir, "routes");
    if (exists(path.join(appDir, "root.tsx"))) {
      const routeFiles: string[] = [];
      listFiles(routesDir, routeFiles);
      for (const file of routeFiles) add(file);
    }

    // Next app router: every `page`, `layout`, `route`, and error boundary.
    const nextAppDir = path.join(dir, "app");
    if (exists(path.join(dir, "next.config.ts")) || exists(path.join(dir, "next.config.mjs"))) {
      const pageFiles: string[] = [];
      listFiles(nextAppDir, pageFiles);
      for (const file of pageFiles) add(file);
    }
  }

  return roots;
}

function listFiles(dir: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      listFiles(full, out);
    } else if (SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
      out.push(full);
    }
  }
}

function exists(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Resolve a path with no extension to the source file it denotes. */
function resolveFileish(base: string): string | undefined {
  if (exists(base) && SOURCE_EXTENSIONS.includes(path.extname(base))) return base;
  // TypeScript lets `./x.js` denote `./x.ts`; strip the emitted extension.
  const withoutJs = base.replace(/\.[cm]?js$/, "");
  for (const ext of SOURCE_EXTENSIONS) {
    if (exists(withoutJs + ext)) return withoutJs + ext;
  }
  for (const ext of SOURCE_EXTENSIONS) {
    const indexFile = path.join(withoutJs, `index${ext}`);
    if (exists(indexFile)) return indexFile;
  }
  return undefined;
}

/** One `compilerOptions.paths` entry, pre-resolved against its workspace. */
interface PathAlias {
  /** Directory the alias belongs to; only files beneath it may use it. */
  scopeDir: string;
  prefix: string;
  suffix: string;
  targets: string[];
}

/**
 * Strip comments so a tsconfig with JSONC syntax still parses. The scan is
 * string-aware: `"@/*"` is a legitimate path pattern, and a naive regex reads
 * its `/*` as the start of a block comment and eats the rest of the file.
 */
function readJsonc(file: string): unknown {
  const text = readFileSync(file, "utf8");
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[++i] ?? "";
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += char;
  }
  // Tolerate trailing commas, which tsconfig permits and JSON does not.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * Collect every workspace's `compilerOptions.paths` mapping. Without these the
 * walk cannot follow `@/lib/source` or `~/components/x` and would declare
 * whole applications dead.
 */
function collectPathAliases(workspaceDirs: Map<string, string>): PathAlias[] {
  const aliases: PathAlias[] = [];
  for (const dir of workspaceDirs.values()) {
    let paths: Record<string, string[]> | undefined;
    try {
      const config = readJsonc(path.join(dir, "tsconfig.json")) as {
        compilerOptions?: { paths?: Record<string, string[]> };
      };
      paths = config.compilerOptions?.paths;
    } catch {
      continue;
    }
    if (!paths) continue;
    for (const [pattern, targets] of Object.entries(paths)) {
      const star = pattern.indexOf("*");
      aliases.push({
        scopeDir: dir,
        prefix: star === -1 ? pattern : pattern.slice(0, star),
        suffix: star === -1 ? "" : pattern.slice(star + 1),
        targets: targets.map((t) => path.resolve(dir, t)),
      });
    }
  }
  // Longest prefix first so `@/lib/*` wins over `@/*`.
  return aliases.sort((a, b) => b.prefix.length - a.prefix.length);
}

function resolveAlias(
  specifier: string,
  fromFile: string,
  aliases: PathAlias[]
): string | undefined {
  for (const alias of aliases) {
    if (!fromFile.startsWith(`${alias.scopeDir}${path.sep}`)) continue;
    if (!specifier.startsWith(alias.prefix)) continue;
    if (alias.suffix && !specifier.endsWith(alias.suffix)) continue;
    const middle = specifier.slice(
      alias.prefix.length,
      alias.suffix ? specifier.length - alias.suffix.length : undefined
    );
    for (const target of alias.targets) {
      const resolved = resolveFileish(target.replace("*", middle));
      if (resolved) return resolved;
    }
  }
  return undefined;
}

/** Map a module specifier seen in `fromFile` to an absolute source path. */
function resolveSpecifier(
  specifier: string,
  fromFile: string,
  aliases: PathAlias[],
  workspaceDirs: Map<string, string>
): string | undefined {
  if (specifier.startsWith(".")) {
    return resolveFileish(path.resolve(path.dirname(fromFile), specifier));
  }
  if (!specifier.startsWith(SCOPE_PREFIX)) {
    return resolveAlias(specifier, fromFile, aliases);
  }
  const rest = specifier.slice(SCOPE_PREFIX.length);
  const slash = rest.indexOf("/");
  const pkg = slash === -1 ? rest : rest.slice(0, slash);
  const subpath = slash === -1 ? "" : rest.slice(slash + 1);
  const dir = workspaceDirs.get(pkg);
  if (!dir) return undefined;
  return resolveFileish(path.join(dir, "src", subpath || "index"));
}

/** Discover every `@tulipfarm/*` workspace directory, keyed by short name. */
export function workspaceDirectories(root: string): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const base of ["packages", "apps"]) {
    let entries: string[];
    try {
      entries = readdirSync(path.join(root, base));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = path.join(root, base, entry);
      try {
        const name = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name;
        if (typeof name === "string" && name.startsWith(SCOPE_PREFIX)) {
          dirs.set(name.slice(SCOPE_PREFIX.length), dir);
        }
      } catch {
        // Not a workspace; `packages/validation` style orphans land here.
      }
    }
  }
  return dirs;
}

function parseModule(file: string): ModuleRecord {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const record: ModuleRecord = {
    file,
    exports: new Map(),
    starReexports: [],
    imports: [],
    referenced: new Map(),
    hasSideEffects: false,
    workerSpecifiers: [],
    classMethods: [],
    memberReferences: new Set(),
  };

  const declareExport = (name: string, src: ExportSource) => record.exports.set(name, src);

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
      const clause = statement.importClause;
      if (!clause) {
        record.imports.push({ specifier, sourceName: "*", isType: false });
        continue;
      }
      const typeOnly = clause.isTypeOnly;
      if (clause.name) {
        record.imports.push({
          specifier,
          sourceName: "default",
          local: clause.name.text,
          isType: typeOnly,
        });
      }
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        record.imports.push({
          specifier,
          sourceName: "*",
          local: bindings.name.text,
          isType: typeOnly,
        });
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          record.imports.push({
            specifier,
            sourceName: (element.propertyName ?? element.name).text,
            local: element.name.text,
            isType: typeOnly || element.isTypeOnly,
          });
        }
      }
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier
        ? (statement.moduleSpecifier as ts.StringLiteral).text
        : undefined;
      if (!statement.exportClause) {
        if (specifier) record.starReexports.push(specifier);
        continue;
      }
      if (ts.isNamespaceExport(statement.exportClause)) {
        if (specifier) {
          record.starReexports.push(specifier);
          declareExport(statement.exportClause.name.text, {
            kind: "reexport",
            specifier,
            sourceName: "*",
            isType: statement.isTypeOnly,
          });
        }
        continue;
      }
      for (const element of statement.exportClause.elements) {
        const sourceName = (element.propertyName ?? element.name).text;
        const isType = statement.isTypeOnly || element.isTypeOnly;
        if (specifier) {
          declareExport(element.name.text, { kind: "reexport", specifier, sourceName, isType });
        } else {
          declareExport(element.name.text, { kind: "local", isType });
          bumpReference(record, sourceName);
        }
      }
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      declareExport("default", { kind: "local", isType: false });
      continue;
    }

    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const exported = modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (exported) {
      const isType =
        ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        (ts.isVariableStatement(statement) && statement.declarationList.flags === undefined);
      if (isDefault) {
        declareExport("default", { kind: "local", isType: false });
      } else if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          for (const name of bindingNames(decl.name)) {
            declareExport(name, { kind: "local", isType: false });
          }
        }
      } else if (
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)
      ) {
        if (statement.name && ts.isIdentifier(statement.name)) {
          declareExport(statement.name.text, { kind: "local", isType: false });
          if (ts.isClassDeclaration(statement)) {
            collectPublicMethods(statement, statement.name.text, record);
          }
        }
      } else if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
        declareExport(statement.name.text, { kind: "local", isType: true });
      } else if (isType) {
        // Unreachable in practice; keeps the branch total.
      }
      continue;
    }

    if (
      !ts.isFunctionDeclaration(statement) &&
      !ts.isClassDeclaration(statement) &&
      !ts.isInterfaceDeclaration(statement) &&
      !ts.isTypeAliasDeclaration(statement) &&
      !ts.isVariableStatement(statement) &&
      !ts.isEnumDeclaration(statement) &&
      !ts.isModuleDeclaration(statement)
    ) {
      record.hasSideEffects = true;
    }
  }

  collectReferences(source, record);
  return record;
}

function bumpReference(record: ModuleRecord, name: string): void {
  record.referenced.set(name, (record.referenced.get(name) ?? 0) + 1);
}

/**
 * Whether a locally declared export is used elsewhere in its own module. The
 * declaration contributes one reference of its own name, so a second
 * occurrence is the first real use.
 */
function usedWithinOwnModule(record: ModuleRecord, name: string): boolean {
  return (record.referenced.get(name) ?? 0) > 1;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const names: string[] = [];
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) names.push(...bindingNames(element.name));
  }
  return names;
}

/**
 * Public, named methods of an exported class. `private`/`protected` members
 * cannot have an outside caller by definition, constructors are reached by
 * `new`, and accessors are reached by reading the property — none of them is
 * the defect this looks for, which is a public operation nobody invokes.
 */
function collectPublicMethods(
  declaration: ts.ClassDeclaration,
  className: string,
  record: ModuleRecord
): void {
  for (const member of declaration.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    if (!ts.isIdentifier(member.name)) continue;
    const modifiers = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : [];
    const hidden = modifiers.some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.PrivateKeyword ||
        modifier.kind === ts.SyntaxKind.ProtectedKeyword
    );
    if (hidden) continue;
    record.classMethods.push({ className, method: member.name.text });
  }
}

/** Every string literal anywhere inside an expression, in source order. */
function collectStringLiterals(node: ts.Node, into: string[]): void {
  if (ts.isStringLiteralLike(node)) {
    into.push(node.text);
    return;
  }
  ts.forEachChild(node, (child) => collectStringLiterals(child, into));
}

/**
 * Record every identifier the module mentions outside of an import clause,
 * plus the targets of dynamic `import()` calls.
 */
function collectReferences(source: ts.SourceFile, record: ModuleRecord): void {
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) return;
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      record.imports.push({
        specifier: node.arguments[0].text,
        sourceName: "*",
        isType: false,
      });
      return;
    }
    // A worker thread's entry module is named by a runtime-assembled path, so
    // no import edge exists and the graph would call a live entrypoint dead.
    // Two shapes occur: `new Worker("./x.ts")`, and this repo's
    // `resolveHookWorkerPath(__dirname, "hook-worker")`, where the literal and
    // the `new Worker` sit in different files. Matching the helper by name is
    // the same kind of repo knowledge `discoverRoots` already encodes for
    // Remix and Next, and it stays exact: a third call site is picked up
    // automatically, and nothing else is.
    if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isIdentifier(node.expression)
          ? node.expression.text
          : "";
      if (callee === "Worker" || /WorkerPath$/.test(callee)) {
        for (const argument of node.arguments ?? []) {
          collectStringLiterals(argument, record.workerSpecifiers);
        }
      }
    }
    // A property access's right side is a member name, not a free identifier.
    if (ts.isPropertyAccessExpression(node)) {
      record.memberReferences.add(node.name.text);
      visit(node.expression);
      return;
    }
    // `{ close: ... }` implements an interface method just as `x.close` calls one.
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      record.memberReferences.add(node.name.text);
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      record.memberReferences.add(node.name.text);
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      record.memberReferences.add(node.argumentExpression.text);
    }
    if (ts.isIdentifier(node)) {
      bumpReference(record, node.text);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
}

/**
 * Entry modules of worker threads, which are named by a runtime-assembled path
 * rather than an import. `apps/api/src/hooks/hook-worker.ts` is one: nothing
 * imports it, yet every Resource hook in production runs inside it.
 *
 * Resolution is relative to the spawning module's own directory, and a literal
 * that names no real file is ignored — so this can only ever mark *more* code
 * live. That asymmetry is deliberate: under-reporting costs a missed cleanup,
 * while over-reporting accuses working code of being dead, which is the error
 * a fitness function must never make.
 */
function dynamicModuleRoots(modules: Map<string, ModuleRecord>): Set<string> {
  const roots = new Set<string>();
  for (const record of modules.values()) {
    const dir = path.dirname(record.file);
    for (const specifier of record.workerSpecifiers) {
      if (specifier.includes("\n") || specifier.trim() === "") continue;
      const base = specifier.replace(/\.(c?js|cjs|mjs)$/, "");
      const resolved = resolveFileish(path.resolve(dir, base));
      if (resolved && resolved !== record.file) roots.add(resolved);
    }
  }
  return roots;
}

interface Graph {
  modules: Map<string, ModuleRecord>;
  resolve: (specifier: string, fromFile: string) => string | undefined;
  roots: Set<string>;
}

function buildGraph(root: string): Graph {
  const workspaceDirs = workspaceDirectories(root);
  const aliases = collectPathAliases(workspaceDirs);
  const files: string[] = [];
  for (const base of ["packages", "apps"]) listFiles(path.join(root, base), files);

  const modules = new Map<string, ModuleRecord>();
  for (const file of files) modules.set(file, parseModule(file));

  const cache = new Map<string, string | undefined>();
  const resolve = (specifier: string, fromFile: string): string | undefined => {
    const key = `${fromFile}\0${specifier}`;
    if (cache.has(key)) return cache.get(key);
    const resolved = resolveSpecifier(specifier, fromFile, aliases, workspaceDirs);
    cache.set(key, resolved);
    return resolved;
  };
  return {
    modules,
    resolve,
    roots: new Set([...discoverRoots(root, workspaceDirs), ...dynamicModuleRoots(modules)]),
  };
}

/**
 * Follow re-export chains until the module that actually declares `name`.
 * Returns every owner reached; `export *` fan-out can legitimately produce
 * more than one candidate when a name is ambiguous. `onVisit` fires for each
 * module the chain passes through, so pass-through barrels are not mistaken
 * for dead code.
 */
function findOwners(
  graph: Graph,
  file: string,
  name: string,
  onVisit: (file: string) => void,
  seen = new Set<string>()
): Array<{ file: string; name: string }> {
  const key = `${file}\0${name}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const record = graph.modules.get(file);
  if (!record) return [];
  onVisit(file);

  const direct = record.exports.get(name);
  if (direct) {
    if (direct.kind === "local") return [{ file, name }];
    const target = graph.resolve(direct.specifier, file);
    if (!target) return [{ file, name }];
    if (direct.sourceName === "*") return [{ file, name }];
    return findOwners(graph, target, direct.sourceName, onVisit, seen);
  }

  const owners: Array<{ file: string; name: string }> = [];
  for (const specifier of record.starReexports) {
    const target = graph.resolve(specifier, file);
    if (target) owners.push(...findOwners(graph, target, name, onVisit, seen));
  }
  return owners;
}

interface WalkResult {
  liveFiles: Set<string>;
  liveExports: Set<string>;
}

/** Walk the graph from `roots`, marking loaded modules and named exports. */
function walk(graph: Graph, roots: string[]): WalkResult {
  const liveFiles = new Set<string>();
  const liveExports = new Set<string>();
  const queue: string[] = [];

  const markFile = (file: string) => {
    if (liveFiles.has(file)) return;
    liveFiles.add(file);
    queue.push(file);
  };
  const markExport = (file: string, name: string) => {
    for (const owner of findOwners(graph, file, name, markFile)) {
      liveExports.add(`${owner.file}\0${owner.name}`);
      markFile(owner.file);
    }
  };
  const markAllExports = (file: string, seen = new Set<string>()) => {
    if (seen.has(file)) return;
    seen.add(file);
    const record = graph.modules.get(file);
    if (!record) return;
    markFile(file);
    for (const name of record.exports.keys()) markExport(file, name);
    for (const specifier of record.starReexports) {
      const target = graph.resolve(specifier, file);
      if (target) markAllExports(target, seen);
    }
  };

  for (const root of roots) markFile(root);

  while (queue.length > 0) {
    const file = queue.pop() as string;
    const record = graph.modules.get(file);
    if (!record) continue;
    for (const imported of record.imports) {
      const target = graph.resolve(imported.specifier, file);
      if (!target) continue;
      // A side-effect or namespace import cannot be narrowed to named symbols.
      if (imported.sourceName === "*") {
        if (imported.local === undefined || record.referenced.has(imported.local)) {
          markAllExports(target);
        } else {
          markFile(target);
        }
        continue;
      }
      if (imported.local !== undefined && !record.referenced.has(imported.local)) {
        // Imported but never mentioned: the module still loads, the symbol is
        // not consumed.
        markFile(target);
        continue;
      }
      markFile(target);
      markExport(target, imported.sourceName);
    }
  }

  return { liveFiles, liveExports };
}

/**
 * Classify every exported value in the repository by whether a production
 * entrypoint can reach it.
 */
export function analyseReachability(root: string): ReachabilityReport {
  const graph = buildGraph(root);
  const rel = (file: string) => path.relative(root, file).split(path.sep).join("/");

  const prodRoots: string[] = [];
  const testRoots: string[] = [];
  for (const file of graph.modules.keys()) {
    const relPath = rel(file);
    if (isTestFile(relPath)) testRoots.push(file);
    else if (graph.roots.has(file)) prodRoots.push(file);
  }

  const prod = walk(graph, prodRoots);
  const withTests = walk(graph, [...prodRoots, ...testRoots]);

  const findings: ExportFinding[] = [];
  const overExported: Array<{ file: string; name: string }> = [];
  for (const [file, record] of graph.modules) {
    const relPath = rel(file);
    if (isTestFile(relPath) || graph.roots.has(file)) continue;
    const moduleLiveInProd = prod.liveFiles.has(file);
    for (const [name, source] of record.exports) {
      if (source.kind === "reexport") continue;
      if (source.isType) continue;
      if (FRAMEWORK_EXPORTS.has(name)) continue;
      const key = `${file}\0${name}`;
      if (prod.liveExports.has(key)) continue;
      // Production loads the module and the module uses the symbol itself, so
      // it does execute in production. The export is merely unnecessary.
      if (moduleLiveInProd && usedWithinOwnModule(record, name)) {
        overExported.push({ file: relPath, name });
        continue;
      }
      const reachedByTests = withTests.liveExports.has(key);
      // Test support is *meant* to stop at the test boundary.
      if (reachedByTests && isTestSupportFile(relPath)) continue;
      findings.push({
        file: relPath,
        name,
        reachability: reachedByTests ? "test-only" : "unreferenced",
      });
    }
  }

  const deadModules: string[] = [];
  for (const file of graph.modules.keys()) {
    const relPath = rel(file);
    if (isTestFile(relPath) || graph.roots.has(file)) continue;
    if (!prod.liveFiles.has(file)) deadModules.push(relPath);
  }

  // A public method is judged by name alone, against every member name any
  // production-reachable module mentions. Without a type checker that is the
  // only sound direction: a shared name grants liveness to both owners, so the
  // check under-reports rather than accusing a method that is in fact called.
  const namedInProd = new Set<string>();
  for (const file of prod.liveFiles) {
    const record = graph.modules.get(file);
    if (!record || isTestFile(rel(file))) continue;
    for (const name of record.memberReferences) namedInProd.add(name);
  }
  const deadMethods: MethodFinding[] = [];
  for (const [file, record] of graph.modules) {
    const relPath = rel(file);
    if (isTestFile(relPath) || !prod.liveFiles.has(file)) continue;
    for (const { className, method } of record.classMethods) {
      if (namedInProd.has(method)) continue;
      if (PROTOCOL_METHODS.has(method)) continue;
      deadMethods.push({ file: relPath, className, method });
    }
  }
  deadMethods.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.className.localeCompare(b.className) ||
      a.method.localeCompare(b.method)
  );

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  overExported.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  deadModules.sort();
  return {
    findings,
    deadModules,
    overExported,
    deadMethods,
    roots: prodRoots.map(rel).sort(),
    scannedFiles: graph.modules.size,
  };
}
