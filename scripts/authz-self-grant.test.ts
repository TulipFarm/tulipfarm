import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCapabilityCatalog } from "../apps/api/src/authz/capabilities";
import { buildLevelDefinition, LevelError } from "../apps/api/src/soul/roles/authoring";
import type { ToolDef } from "../packages/tool-host/src";

/**
 * Fitness function for authorization-design D8: **authorization governs itself.**
 *
 * Roles are Soul-authored, and the Soul is Agent-writable. That combination is the whole risk:
 * if any Agent-reachable Tool could construct a Soul write naming a `Role`, an Agent could edit
 * the file that defines its own authority, and D8 would be a sentence rather than a property.
 *
 * Today it cannot — but only *by absence*. There is no positive guard anywhere in the code: the
 * `SoulWriter` accepts any `ArtifactKind` (`packages/soul/src/writer.ts` — `SoulWriteTarget.kind:
 * ArtifactKind`, with no kind allow-list), and `Role` is a perfectly ordinary entry in
 * `ARTIFACT_LAYOUTS`. What actually stops an Agent is that nobody has yet written a Tool that
 * emits one. A single new `role_forge` Tool, or one generic artifact-write Tool taking `kind` as
 * an argument, would invert the answer silently and pass every existing test.
 *
 * This file is that missing guard, expressed as three invariants over the production composition:
 *
 *  1. **One writer.** Exactly one product module constructs a Soul write of an authorization
 *     artifact kind, and it is the admin-gated level-authoring service.
 *  2. **No Tool reaches it.** That module is outside the transitive import closure of every
 *     Tool-definition module, so no Tool can call it even indirectly.
 *  3. **No Tool can be granted authority over authorization.** The capability catalog a
 *     business-authored access level is built from is derived *from Tool declarations*, so an
 *     `authz.*` action on any Tool would immediately become an authorable capability — a level
 *     that grants the power to write levels. No Tool declares one, and `buildLevelDefinition`
 *     refuses to author what the catalog does not offer.
 *
 * Invariant 3 is why the whole scheme holds: `authz.*` is a route-only vocabulary. Business
 * policy can therefore never grant authority over business policy; only the built-in `owner` and
 * `admin` Roles carry it, and `scripts/authz-lockout-safety.test.ts` pins those.
 */

function repoRoot(): string {
  let directory = __dirname;
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("pnpm-workspace.yaml not found");
    directory = parent;
  }
}

const ROOT = repoRoot();

/**
 * `live` artifact kinds that *are* authorization policy. A Soul write naming one of these is a
 * change to who may do what, which is the only class of write this test governs.
 */
const AUTHORIZATION_ARTIFACT_KINDS = ["Role", "AccessGrant"] as const;
const KINDS = AUTHORIZATION_ARTIFACT_KINDS.join("|");

/** `target: { kind: "Role", … }` — the `put` half of a changeset. */
const PUT_AUTHORIZATION_ARTIFACT = new RegExp(`target:\\s*\\{\\s*kind:\\s*"(?:${KINDS})"`);
/** `{ op: "deleteArtifact", kind: "Role", … }` — the delete half. */
const DELETE_AUTHORIZATION_ARTIFACT = new RegExp(`deleteArtifact"\\s*,\\s*kind:\\s*"(?:${KINDS})"`);

/**
 * The one module allowed to write an authorization artifact. It is reached only from
 * `apps/api/src/soul/roles/routes.ts`, whose every mutating route declares
 * `{ action: "authz.level.write", resourceType: "authz", fallback: "admin" }`.
 */
const SOLE_AUTHORIZATION_WRITER = "apps/api/src/soul/roles/authoring.ts";

const PRODUCT_ROOTS = [
  "apps/api/src",
  "apps/worker/src",
  "apps/integration-worker/src",
  ...readdirSync(join(ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/src`),
].filter((path) => existsSync(join(ROOT, path)));

function sourceFiles(root: string): readonly string[] {
  const files: string[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
      files.push(relative(ROOT, full).split(sep).join("/"));
    }
  }
  walk(join(ROOT, root));
  return files;
}

const PRODUCT_FILES: readonly string[] = PRODUCT_ROOTS.flatMap(sourceFiles).sort();

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/**
 * A Tool-definition module: the entrypoints an Agent's Tool call can land in. Both the
 * `<feature>/tools.ts` convention and anything under a `tools/` directory, in the API, the
 * Workers, and the shared packages that host Tools.
 */
function isToolModule(path: string): boolean {
  return path.endsWith("/tools.ts") || /\/tools\//.test(path) || path.endsWith("-tools.ts");
}

/** Relative import specifiers, resolved to repo-relative `.ts` paths. */
function localImports(path: string, source: string): readonly string[] {
  const directory = dirname(path);
  const resolved: string[] = [];
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*"(\.[^"]*)"/g)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    const base = join(directory, specifier).split(sep).join("/");
    for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
      if (existsSync(join(ROOT, candidate))) {
        resolved.push(candidate);
        break;
      }
    }
  }
  return resolved;
}

/** Every module reachable from `entries` by relative import, transitively. */
function importClosure(entries: readonly string[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const path = queue.pop();
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    if (!existsSync(join(ROOT, path))) continue;
    queue.push(...localImports(path, read(path)));
  }
  return seen;
}

/** Every `action` declared inside a Tool's `authorization` contract, across the whole repo. */
function declaredToolActions(): readonly string[] {
  const actions = new Set<string>();
  for (const path of PRODUCT_FILES) {
    for (const match of read(path).matchAll(
      /authorization:\s*\{[\s\S]{0,600}?action:\s*"([^"]+)"/g
    )) {
      if (match[1] !== undefined) actions.add(match[1]);
    }
  }
  return [...actions].sort();
}

/**
 * A minimal `ToolDef` carrying one declaration — enough for the real catalog builder, which reads
 * `tool.definition.authorization` and nothing else.
 */
function toolFor(action: string): ToolDef {
  return {
    name: action.replace(/\./g, "_"),
    tier: "read",
    mutating: false,
    description: action,
    inputSchema: { type: "object" },
    execute: async () => ({ ok: true, data: {} }),
    definition: { authorization: { action, resources: [action.split(".")[0] ?? action] } },
  } as unknown as ToolDef;
}

describe("an Agent cannot author its own authority (D8)", () => {
  it("scans a non-trivial amount of product source, so nothing below is vacuous", () => {
    expect(PRODUCT_FILES.length).toBeGreaterThan(500);
    expect(PRODUCT_FILES).toContain(SOLE_AUTHORIZATION_WRITER);
  });

  it("has exactly one module that writes an authorization artifact to Soul", () => {
    const writers = PRODUCT_FILES.filter((path) => {
      const source = read(path);
      return PUT_AUTHORIZATION_ARTIFACT.test(source) || DELETE_AUTHORIZATION_ARTIFACT.test(source);
    });

    expect(
      writers,
      "A second writer of a Role or AccessGrant artifact is a second way to change who may do " +
        "what. Route every authorization write through the admin-gated level-authoring service."
    ).toEqual([SOLE_AUTHORIZATION_WRITER]);
  });

  it("keeps that writer outside the import closure of every Tool", () => {
    const toolModules = PRODUCT_FILES.filter(isToolModule);
    expect(toolModules.length).toBeGreaterThan(5);

    const reachable = importClosure(toolModules);
    expect(
      reachable.has(SOLE_AUTHORIZATION_WRITER),
      `${SOLE_AUTHORIZATION_WRITER} became reachable from a Tool. The Soul is Agent-writable, so ` +
        "an Agent that can reach the Role writer can edit the file defining its own authority."
    ).toBe(false);
  });

  it("declares no authz.* action on any Tool, so no level can grant authority over authorization", () => {
    const actions = declaredToolActions();
    expect(actions.length).toBeGreaterThan(50);
    expect(
      actions.filter((action) => action.startsWith("authz.")),
      "`authz.*` is a route-only vocabulary. A Tool declaring one makes it an authorable " +
        "capability, so a business-authored access level could grant the power to write levels."
    ).toEqual([]);
  });

  it("refuses to author a level granting an authz.* capability", () => {
    const catalog = buildCapabilityCatalog(declaredToolActions().map(toolFor));
    const offered = new Set(
      catalog.areas.flatMap((area) => area.capabilities.map((capability) => capability.id))
    );
    // Non-vacuity: an empty catalog would refuse everything, including `authz.*`, for the wrong
    // reason. The real deployment offers dozens of capabilities.
    expect(offered.size).toBeGreaterThan(50);
    expect([...offered].filter((id) => id.startsWith("authz."))).toEqual([]);

    for (const capability of ["authz.level.write", "authz.role.assign", "authz.role.author"]) {
      let error: unknown;
      try {
        buildLevelDefinition({ name: "Escalation", capabilities: [capability] }, catalog);
      } catch (thrown) {
        error = thrown;
      }
      expect(error, `authoring a level granting ${capability} must fail`).toBeInstanceOf(
        LevelError
      );
      expect((error as LevelError).code).toBe("unknown_capabilities");
    }
  });
});
