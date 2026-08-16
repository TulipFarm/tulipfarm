import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Fitness function for L4-2: `delegate_to_agent` must start a child Run, and every child Run must
 * pass the delegation guard.
 *
 * Both halves of child-Run execution were built and unit-tested, and neither was ever constructed
 * in production: `DelegationCoordinator` had no caller, and `delegate_to_agent` returned a
 * "delegated" receipt for work that never started. A unit test on the coordinator cannot see that
 * — it constructs the coordinator itself. Only a test that reads the composition can.
 *
 * Two properties, and delegation is a lie again if either is cut:
 *   1. The tool reaches the coordinator: tool handler → `ctx.delegateToAgent` → API wiring →
 *      `createAgentDelegation` → `DelegationCoordinator`.
 *   2. The coordinator is the only door: nothing outside it holds a `ChildRunStarter`, and
 *      nothing outside `run-kernel` calls `ChildRunManager.spawn`.
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
const API_INDEX = join(ROOT, "apps/api/src/index.ts");
const DELEGATE_TOOL = join(ROOT, "apps/api/src/platform/delegate-tool.ts");
const COORDINATOR = join(ROOT, "packages/agent-runtime/src/delegation/delegate.ts");
const COMPOSITION = join(ROOT, "packages/agent-runtime/src/delegation/composition.ts");
const CHILDREN = join(ROOT, "packages/run-kernel/src/children.ts");
const CHILD_AUTHORITY = join(ROOT, "packages/agent-runtime/src/delegation/child-authority.ts");
const TURN_CONTEXT = join(ROOT, "apps/api/src/internal/turn-context.ts");
const LOCAL_TOOL_HOST = join(ROOT, "apps/worker/src/tools/local-host.ts");
const API_TOOL_DISPATCH = join(ROOT, "apps/api/src/internal/tool-dispatch.ts");
const DEBT = join(ROOT, "scripts/reachability-debt.json");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Every non-test `.ts`/`.tsx` file under `directory`, read as `{ path, source }`. */
function productionSources(directory: string): readonly { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", "test", "__tests__"].includes(entry.name)) continue;
      out.push(...productionSources(full));
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.includes(".test.")
    ) {
      out.push({ path: full, source: readFileSync(full, "utf8") });
    }
  }
  return out;
}

const WORKSPACES = ["apps", "packages"].map((name) => join(ROOT, name));
const ALL_SOURCES = WORKSPACES.flatMap((directory) => productionSources(directory));

describe("delegation child-Run wiring (L4-2)", () => {
  it("the delegate_to_agent handler calls the composed delegation path, not a receipt", () => {
    const source = read(DELEGATE_TOOL);

    expect(source).toContain("ctx.delegateToAgent(");
    // The pre-fix handler answered `status: "delegated"` without starting anything.
    expect(source).not.toContain('status: "delegated"');
  });

  it("refuses rather than pretending when delegation is not composed", () => {
    const source = read(DELEGATE_TOOL);

    expect(source).toMatch(/if \(!ctx\.delegateToAgent \|\| parentRunId === undefined\)/);
    expect(source).toContain('err("unavailable"');
  });

  it("the API composes createAgentDelegation onto the platform Tool context", () => {
    const source = read(API_INDEX);

    expect(source).toMatch(/createAgentDelegation,[\s\S]*from "\.\/platform\/delegation"/);
    expect(source).toContain("createAgentDelegation({");
    expect(source).toContain("delegateToAgent: agentDelegation.delegate");
  });

  it("that composition builds a DelegationCoordinator over the durable link store", () => {
    const composition = read(COMPOSITION);
    const wiring = read(API_INDEX);

    expect(composition).toContain("new DelegationCoordinator({");
    expect(composition).toContain("new ChildRunManager(deps.links, deps.ancestry)");
    expect(composition).toContain("policy: { maxDepth: DELEGATION_MAX_DEPTH }");
    // The durable halves are supplied by the app, not faked inside the package.
    expect(wiring).toContain("links: new ChildLinkStore(runTransactions)");
    expect(wiring).toContain("const childLinks = new ChildLinkAncestryStore(pool);");
    expect(wiring).toContain("ancestry: childLinks,");
  });

  it("the coordinator owns the run-minting port, so no caller can start a child beside it", () => {
    const coordinator = read(COORDINATOR);

    expect(coordinator).toContain("readonly starter: ChildRunStarter");
    expect(coordinator).toContain("this.options.starter.start(");

    // A second holder of the port would be a second, unguarded door.
    const holders = ALL_SOURCES.filter(
      ({ path, source }) => path !== COORDINATOR && /:\s*ChildRunStarter\b/.test(source)
    ).map(({ path }) => path);
    expect(holders).toEqual([COMPOSITION]);
  });

  it("the guard runs before the child Run is minted", () => {
    const source = read(COORDINATOR);
    const depth = source.indexOf('DelegationError("depth_limit_exceeded"');
    const deadline = source.indexOf('DelegationError("deadline_amplification"');
    const narrow = source.indexOf("narrowChildAuthority(");
    const mint = source.indexOf("this.options.starter.start(");

    expect(depth).toBeGreaterThan(-1);
    expect(depth).toBeLessThan(mint);
    expect(deadline).toBeLessThan(mint);
    expect(narrow).toBeLessThan(mint);
  });

  it("depth is read from the persisted chain, never supplied by the delegating turn", () => {
    const coordinator = read(COORDINATOR);
    const children = read(CHILDREN);

    expect(coordinator).toContain("this.options.children.ancestors(");
    expect(coordinator).toContain("const depth = chain.length + 1;");
    // Nothing in the request may carry a depth the caller chose.
    expect(coordinator).not.toMatch(/readonly depth: number;[\s\S]{0,200}DelegationRequest/);
    expect(children).toContain("async ancestors(");
    expect(children).toContain("parentLink(businessId: string, childRunId: string)");
  });

  it("only run-kernel and the coordinator ever spawn a child link", () => {
    const spawners = ALL_SOURCES.filter(({ source }) => /\.spawn\(\s*\{/.test(source)).map(
      ({ path }) => path
    );

    expect(spawners.sort()).toEqual([COORDINATOR]);
  });

  it("the L4-2 ledger entries are discharged rather than carried", () => {
    const debt = JSON.parse(read(DEBT)) as {
      testOnly: string[];
      deadMethods: string[];
      justified: Record<string, string>;
    };
    const stale = [
      "packages/agent-runtime/src/delegation/delegate.ts#DelegationCoordinator",
      "packages/agent-runtime/src/delegation/delegate.ts#DelegationError",
      "packages/run-kernel/src/children.ts#ChildRunManager.spawn",
      "packages/run-kernel/src/children.ts#ChildRunManager.listAttached",
    ];

    for (const entry of stale) {
      expect([...debt.testOnly, ...debt.deadMethods]).not.toContain(entry);
      expect(Object.keys(debt.justified)).not.toContain(entry);
    }
  });
});

/**
 * Fitness function for L4-8: the authority a delegation narrowed must bound the child's own Tool
 * loop, not just the delegation hop.
 *
 * L4-2 wrote the narrowed authority into an immutable `run_child_links` row and then nothing read
 * it again: the child's Turn resolved its Tools from its own Soul Agent config, and the Tool
 * dispatcher authorized against that same config. A child granted a read-only Tool set could
 * therefore call a mutating Tool. Unit tests on the guard cannot see that — they construct the
 * guard themselves. Only a test that reads the composition can.
 *
 * Three properties, and the narrowing is decorative again if any is cut:
 *   1. Context assembly narrows what is offered against the link row.
 *   2. Every Tool call passes the guard before the dispatcher, because a model may call a Tool it
 *      was never offered.
 *   3. The intersection is `@tulipfarm/authz`'s, and an unreadable link row refuses.
 */
describe("delegated authority binds the child's own Tool loop (L4-8)", () => {
  it("Context assembly narrows the offered Tools and limits against the link row", () => {
    const source = read(TURN_CONTEXT);

    expect(source).toContain("narrowDelegatedTurn(this.options.childLinks, authority, {");
    expect(source).toContain("tools: delegated.tools,");
    expect(source).toContain("limits: delegated.limits,");
  });

  it("the API supplies the link row to Context assembly and to the Tool dispatcher", () => {
    const source = read(API_INDEX);

    expect(source).toContain("const childLinks = new ChildLinkAncestryStore(pool);");
    expect(source).toMatch(/childLinks,\n\s+githubStatus:/);
    expect(source).toMatch(
      /tools: buildDelegatedToolDispatch\(\{\n\s+links: childLinks,\n\s+catalog: delegationCatalog,/
    );

    const dispatch = read(API_TOOL_DISPATCH);

    expect(dispatch).toMatch(
      /withDelegatedAuthority\(\n\s+\{ links, catalog \},\n\s+new RegistryToolDispatcher\(/
    );
  });

  it("no Tool dispatcher — control plane or co-located — is composed outside that guard", () => {
    const bare = ALL_SOURCES.filter(
      ({ source }) =>
        /new RegistryToolDispatcher\(/.test(source) && !/withDelegatedAuthority\(\s*\{/.test(source)
    ).map(({ path }) => path);

    expect(bare).toEqual([]);
  });

  it("the co-located Tool host is bounded by the same link row as the control plane", () => {
    const source = read(LOCAL_TOOL_HOST);

    expect(source).toContain("withDelegatedAuthority(");
    expect(source).toContain("links: new ChildLinkAncestryStore(options.db)");
  });

  it("the intersection is authz's, not a second copy", () => {
    const source = read(CHILD_AUTHORITY);

    expect(source).toContain('from "@tulipfarm/authz"');
    expect(source).toContain("decideEffectivePermission(");
    // Filtering the offered list is what keeps a grant from manufacturing a Tool.
    expect(source).toContain("return offered.filter(");
  });

  it("an unreadable link row refuses instead of falling back to the Agent config", () => {
    const source = read(CHILD_AUTHORITY);
    const readAt = source.indexOf("await links.parentLink(");
    const refuseAt = source.indexOf('throw new ChildAuthorityError("link_unreadable"');

    expect(readAt).toBeGreaterThan(-1);
    expect(refuseAt).toBeGreaterThan(readAt);
    // A catch that answered "unlinked" would be exactly the fallback this forbids.
    expect(source).not.toMatch(/catch[\s\S]{0,80}return UNLINKED_RUN/);
  });

  it("the root of a chain is seeded from the live catalog, so the grant describes real authority", () => {
    const composition = read(COMPOSITION);
    const wiring = read(API_INDEX);

    expect(composition).toContain("rootAuthority: rootDelegationAuthority(");
    expect(composition).toContain("tools: catalog.map((tool) => tool.name),");
    expect(wiring).toContain("delegationCatalogOf({ getAll: () => toolRegistry.getAll() })");
  });
});
