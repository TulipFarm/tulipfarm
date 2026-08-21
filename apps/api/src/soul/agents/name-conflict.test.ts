import type { GitSyncService, SoulAgent, SoulLoader, SoulWriter } from "@tulipfarm/soul";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_TOOLS, type AgentToolContext } from "./tools";

function makeSoulLoader(agents: SoulAgent[]): SoulLoader {
  return {
    agents: new Map(agents.map((agent) => [agent.name, agent])),
    reload: vi.fn().mockResolvedValue(undefined),
  } as unknown as SoulLoader;
}

function makeSoulWriter(): SoulWriter & { apply: ReturnType<typeof vi.fn> } {
  return {
    apply: vi.fn().mockResolvedValue({
      commitSha: "abc1234",
      filesChanged: 1,
      paths: [],
      pushed: false,
      published: true,
    }),
  } as unknown as SoulWriter & { apply: ReturnType<typeof vi.fn> };
}

const createTool = AGENT_TOOLS.find(
  (tool) => tool.name === "agent_create"
) as (typeof AGENT_TOOLS)[number];

const EXISTING_LABEL = "FAQ Support Agent";

describe("agent_create refuses a duplicate Agent name in the Tool execution path", () => {
  let soulWriter: ReturnType<typeof makeSoulWriter>;

  function ctx(agents: SoulAgent[]): AgentToolContext {
    return {
      gitSync: {} as GitSyncService,
      soulLoader: makeSoulLoader(agents),
      soulWriter,
    };
  }

  beforeEach(() => {
    soulWriter = makeSoulWriter();
  });

  // #435: the collision is on the *display* name. The slugs differ, so the Soul writer's
  // absent-slug precondition never fires and the duplicate lands silently.
  it("refuses a frontmatter label that duplicates an existing Agent, even when the slug is free", async () => {
    const existing: SoulAgent = {
      name: "qa-20260819-0102-fullstaging-authtest",
      frontmatter: { label: EXISTING_LABEL },
      body: "original",
    };

    const result = await createTool.handler(
      {
        name: "faq-support-agent",
        body: "answers pricing questions",
        frontmatter: { label: EXISTING_LABEL, domain: "qa-stress-dup" },
      },
      ctx([existing])
    );

    expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(JSON.stringify(result)).toContain(existing.name);
    expect(soulWriter.apply).not.toHaveBeenCalled();
  });

  // #463: the refusal must carry the resolution vocabulary, or the caller has nothing to do with
  // the user's answer except ask the question again.
  it("names the resolving argument in the refusal", async () => {
    const result = await createTool.handler(
      {
        name: "support-triage",
        body: "triage",
        frontmatter: { label: "Support Triage" },
      },
      ctx([{ name: "support-triage", frontmatter: { label: "Support Triage" }, body: "old" }])
    );

    expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(JSON.stringify(result)).toContain("onExisting");
  });

  // #463: "leave unchanged" must be expressible as a Tool call that SUCCEEDS and writes nothing.
  // Without one the answer has nowhere to land, so every later Turn re-derives the same card.
  it("terminates on 'leave the existing Agent unchanged' without writing", async () => {
    const existing: SoulAgent = {
      name: "support-triage",
      frontmatter: { label: "Support Triage" },
      body: "old",
    };

    const result = await createTool.handler(
      {
        name: "support-triage",
        body: "new body",
        frontmatter: { label: "Support Triage" },
        onExisting: "keep",
      },
      ctx([existing])
    );

    expect(result).toMatchObject({
      success: true,
      data: { name: "support-triage", created: false, changed: false },
    });
    expect(soulWriter.apply).not.toHaveBeenCalled();
  });

  // #463: and so must "update the existing one", in one call, with no second question.
  it("terminates on 'update the existing Agent' with a single write", async () => {
    const existing: SoulAgent = {
      name: "support-triage",
      frontmatter: { label: "Support Triage" },
      body: "old",
    };

    const result = await createTool.handler(
      {
        name: "support-triage",
        body: "new body",
        frontmatter: { label: "Support Triage" },
        onExisting: "update",
      },
      ctx([existing])
    );

    expect(result).toMatchObject({
      success: true,
      data: { name: "support-triage", created: false, changed: true },
    });
    expect(soulWriter.apply).toHaveBeenCalledOnce();
    const request = soulWriter.apply.mock.calls[0]?.[0] as { preconditions?: unknown[] };
    expect(request.preconditions).toBeUndefined();
  });

  // A decided call must never re-enter the undecided branch: answering the question once ends it.
  it("never re-refuses a call that already carries a decision", async () => {
    const agents: SoulAgent[] = [
      { name: "support-triage", frontmatter: { label: "Support Triage" }, body: "old" },
      { name: "other", frontmatter: { label: "Support Triage" }, body: "other" },
    ];
    for (const onExisting of ["keep", "update"] as const) {
      const first = await createTool.handler(
        { name: "support-triage", body: "b", frontmatter: { label: "Support Triage" }, onExisting },
        ctx(agents)
      );
      const second = await createTool.handler(
        { name: "support-triage", body: "b", frontmatter: { label: "Support Triage" }, onExisting },
        ctx(agents)
      );
      expect(first, onExisting).toMatchObject({ success: true });
      expect(second, onExisting).toMatchObject({ success: true });
    }
  });

  it("still creates when nothing collides", async () => {
    const result = await createTool.handler(
      { name: "brand-new", body: "b", frontmatter: { label: "Brand New" } },
      ctx([{ name: "support-triage", frontmatter: { label: "Support Triage" }, body: "old" }])
    );
    expect(result).toMatchObject({ success: true, data: { name: "brand-new", created: true } });
    expect(soulWriter.apply).toHaveBeenCalledOnce();
  });
});
