import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSyncService, SoulWriter } from "@tulipfarm/soul";
import { describe, expect, it, vi } from "vitest";
import { SURFACE_COMPONENT_TOOLS, type SurfaceComponentToolContext } from "./tools";

function getTool(name: string) {
  const tool = SURFACE_COMPONENT_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`tool not found: ${name}`);
  return tool;
}

function makeGitSync(soulPath = "/fake/soul"): GitSyncService {
  return { path: soulPath } as unknown as GitSyncService;
}

function makeSoulWriter(): SoulWriter & { apply: ReturnType<typeof vi.fn> } {
  return {
    apply: vi
      .fn()
      .mockResolvedValue({ commitSha: "abc1234", filesChanged: 1, paths: [], pushed: false }),
  } as unknown as SoulWriter & { apply: ReturnType<typeof vi.fn> };
}

function makeCtx(): SurfaceComponentToolContext & {
  soulWriter: ReturnType<typeof makeSoulWriter>;
} {
  return { gitSync: makeGitSync(), soulWriter: makeSoulWriter() };
}

function statusDefinition(style: Record<string, unknown>) {
  return {
    slug: "release-status",
    version: "1.0",
    description: "A reusable business status.",
    propsSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
    events: [],
    examples: [{ label: "Ready" }],
    targets: [{ channel: "web", surface: "chat" }],
    views: {
      default: {
        component: { name: "Status", version: "1.0" },
        props: { label: { $prop: "/label" }, tone: "positive" },
        style,
      },
    },
  };
}

function expectNoNullishTargetText(targets: unknown): void {
  expect(JSON.stringify(targets)).not.toMatch(/undefined|null/);
}

describe("SURFACE_COMPONENT_TOOLS authorization declarations", () => {
  const createTool = getTool("surface_component_create");
  const updateTool = getTool("surface_component_update");
  const getComponentTool = getTool("surface_component_get");
  const listTool = getTool("surface_component_list");

  it("uses the canonical Soul Surface component target type", () => {
    for (const tool of [createTool, updateTool, getComponentTool]) {
      expect(tool.targetsFor({ slug: "deal-card" }), tool.name).toEqual([
        { type: "soul.surface_component", id: "deal-card" },
      ]);
    }
    expect(listTool.targetsFor({})).toEqual([]);
  });

  it("keeps target derivation total for raw model output", () => {
    const rawInputs: unknown[] = [{}, { unexpected: true }, { slug: 7 }, null, []];
    for (const tool of [createTool, updateTool, getComponentTool]) {
      for (const input of rawInputs) {
        expect(() => tool.targetsFor(input), `${tool.name} target derivation`).not.toThrow();
        expectNoNullishTargetText(tool.targetsFor(input));
      }
    }
  });
});

describe("surface_component_create style validation", () => {
  const createTool = getTool("surface_component_create");

  it("rejects a view node style outside the closed token vocabulary before writing", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler(statusDefinition({ tone: "purple" }), ctx);
    expect(res.success).toBe(false);
    expect(ctx.soulWriter.apply).not.toHaveBeenCalled();
  });

  it("accepts a valid style and publishes it through SoulWriter", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler(statusDefinition({ tone: "warning" }), ctx);
    expect(res.success).toBe(true);
    expect(ctx.soulWriter.apply).toHaveBeenCalledTimes(1);
  });
});

function codeDefinition(source: string) {
  const { views: _views, ...rest } = statusDefinition({});
  return { ...rest, slug: "budget-sheet", code: { web: { source } } };
}

function changesOf(ctx: ReturnType<typeof makeCtx>) {
  return ctx.soulWriter.apply.mock.calls[0]?.[0].changes as Array<{
    op: string;
    target: { companion?: string };
    content?: string;
  }>;
}

describe("surface_component_create code views", () => {
  const createTool = getTool("surface_component_create");

  it("compiles authored JSX and publishes source beside the compiled module", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler(
      codeDefinition("function render(props) { return <div>{props.label}</div>; }"),
      ctx
    );
    expect(res.success).toBe(true);
    const companions = changesOf(ctx).map((change) => change.target.companion);
    expect(companions).toContain("code/web.source.jsx");
    expect(companions).toContain("code/web.js");
    const module = changesOf(ctx).find((c) => c.target.companion === "code/web.js");
    expect(module?.content).toContain("React.createElement");
  });

  it("returns a repairable error for a syntax error in authored source", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler(
      codeDefinition("function render(props) { return <div; }"),
      ctx
    );
    expect(res.success).toBe(false);
    expect(JSON.stringify(res)).toMatch(/line \d+:\d+/);
    expect(ctx.soulWriter.apply).not.toHaveBeenCalled();
  });

  it("refuses authored source that reaches for the network", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler(
      codeDefinition("function render() { fetch('https://example.com'); return <div/>; }"),
      ctx
    );
    expect(res.success).toBe(false);
    expect(JSON.stringify(res)).toContain("fetch");
    expect(ctx.soulWriter.apply).not.toHaveBeenCalled();
  });

  it("leaves a declarative component's changeset unchanged", async () => {
    const ctx = makeCtx();
    await createTool.handler(statusDefinition({ tone: "warning" }), ctx);
    expect(changesOf(ctx).map((change) => change.target.companion)).toEqual([
      undefined,
      "views/default.yaml",
    ]);
  });
});

describe("surface_component_get on a code-view component", () => {
  const getComponentTool = getTool("surface_component_get");

  it("reads a component whose only view is authored code, so it has no views directory", async () => {
    const soulPath = await mkdtemp(join(tmpdir(), "surface-get-"));
    const componentDirectory = join(soulPath, "surface-components", "budget-sheet");
    await mkdir(join(componentDirectory, "code"), { recursive: true });
    await writeFile(
      join(componentDirectory, "component.yaml"),
      'name: business.budget-sheet\nversion: "1.0"\n',
      "utf8"
    );

    const res = await getComponentTool.handler(
      { slug: "budget-sheet" },
      { gitSync: makeGitSync(soulPath), soulWriter: makeSoulWriter() }
    );

    expect(res.success).toBe(true);
    expect(JSON.stringify(res)).toContain("business.budget-sheet");
  });

  it("still reports a slug that was never published as not found", async () => {
    const soulPath = await mkdtemp(join(tmpdir(), "surface-get-"));
    const res = await getComponentTool.handler(
      { slug: "never-published" },
      { gitSync: makeGitSync(soulPath), soulWriter: makeSoulWriter() }
    );
    expect(res.success).toBe(false);
    expect(JSON.stringify(res)).toContain("was not found");
  });
});

describe("surface_component_create rejects an emit no handle can authorise", () => {
  const createTool = getTool("surface_component_create");

  const emittingSource =
    "function render(props, tulip) { return <button onClick={() => tulip.emit(props.commitEvent, {})}>Save</button>; }";

  function emittingDefinition(propsSchema: Record<string, unknown>, example: unknown) {
    const { views: _views, ...rest } = statusDefinition({});
    return {
      ...rest,
      slug: "budget-sheet",
      propsSchema,
      examples: [example],
      events: [
        { name: "sheet.commit", description: "Committed.", inputSchema: { type: "object" } },
      ],
      code: { web: { source: emittingSource } },
    };
  }

  it("refuses an example whose action is a bare event-name string", async () => {
    const res = await createTool.handler(
      emittingDefinition(
        {
          type: "object",
          properties: { commitEvent: { type: "string" } },
          required: ["commitEvent"],
        },
        { commitEvent: "sheet.commit" }
      ),
      makeCtx()
    );

    expect(res.success).toBe(false);
    expect(JSON.stringify(res)).toContain("mints no handle");
  });

  it("publishes when the example carries the action as an object", async () => {
    const res = await createTool.handler(
      emittingDefinition(
        {
          type: "object",
          properties: {
            commitEvent: {
              type: "object",
              properties: { event: { type: "string" } },
              required: ["event"],
            },
          },
          required: ["commitEvent"],
        },
        { commitEvent: { event: "sheet.commit" } }
      ),
      makeCtx()
    );

    expect(res.success).toBe(true);
  });

  it("leaves a code view that never emits alone", async () => {
    const res = await createTool.handler(
      codeDefinition("function render(props) { return <div>{props.label}</div>; }"),
      makeCtx()
    );

    expect(res.success).toBe(true);
  });
});
