import {
  type ChildAuthority,
  type ChildLink,
  type ChildLinkAncestry,
  type ChildLinkStore,
  ChildRunError,
  ChildRunManager,
} from "@tulipfarm/run-kernel";
import { describe, expect, it } from "vitest";
import {
  type ChildRunStarter,
  DELEGATION_DEADLINE_LIMIT_KEY,
  DelegationCoordinator,
  DelegationError,
  type DelegationRequest,
} from "./delegate";

class FakeChildLinkStore implements ChildLinkStore {
  links: ChildLink[] = [];
  failNextLink = false;

  async link(input: {
    parentRunId: string;
    childRunId: string;
    authority: ChildAuthority;
    createdAt: string;
  }): Promise<ChildLink> {
    if (this.failNextLink) throw new Error("link_store_unavailable");
    const existing = this.links.find(
      (link) => link.parentRunId === input.parentRunId && link.childRunId === input.childRunId
    );
    if (existing) return existing;
    const link: ChildLink = {
      parentRunId: input.parentRunId,
      childRunId: input.childRunId,
      authority: input.authority,
      resume: null,
      callId: null,
      detachedAt: null,
      createdAt: input.createdAt,
    };
    this.links.push(link);
    return link;
  }

  async detach(
    _businessId: string,
    parentRunId: string,
    childRunId: string,
    detachedAt: string
  ): Promise<boolean> {
    const index = this.links.findIndex(
      (link) => link.parentRunId === parentRunId && link.childRunId === childRunId
    );
    const existing = this.links[index];
    if (existing === undefined || existing.detachedAt !== null) return false;
    this.links[index] = { ...existing, detachedAt };
    return true;
  }

  async listChildren(_businessId: string, parentRunId: string): Promise<readonly ChildLink[]> {
    return this.links.filter((link) => link.parentRunId === parentRunId);
  }
}

const DEADLINE = Date.parse("2026-07-25T11:00:00.000Z");

const ROOT_AUTHORITY: ChildAuthority = {
  tools: ["github.issue.read", "github.issue.comment", "knowledge.search"],
  classifications: ["internal", "confidential"],
  limits: { toolCalls: 20, costUsd: 5, [DELEGATION_DEADLINE_LIMIT_KEY]: DEADLINE },
};

const READ_ONLY_TOOLS = new Set(["github.issue.read", "knowledge.search"]);

function coordinator(options: { maxDepth?: number } = {}) {
  const store = new FakeChildLinkStore();
  const ancestry: ChildLinkAncestry = {
    parentLink: async (_businessId, childRunId) =>
      store.links.find((link) => link.childRunId === childRunId) ?? null,
  };
  let minted = 0;
  const started: { childRunId: string; authority: ChildAuthority; deadlineAt: string }[] = [];
  const cancelled: string[] = [];
  const starter: ChildRunStarter = {
    start: async (input) => {
      minted += 1;
      const childRunId = `run-child-${minted}`;
      started.push({ childRunId, authority: input.authority, deadlineAt: input.deadlineAt });
      return { childRunId, conversationId: `chat-${minted}` };
    },
    cancel: async (_businessId, childRunId) => {
      cancelled.push(childRunId);
    },
  };
  const delegation = new DelegationCoordinator({
    children: new ChildRunManager(store, ancestry),
    tools: { isReadOnly: (name: string) => READ_ONLY_TOOLS.has(name) },
    starter,
    policy: { maxDepth: options.maxDepth ?? 2 },
  });
  return { delegation, store, started, cancelled };
}

function request(overrides: Partial<DelegationRequest> = {}): DelegationRequest {
  return {
    businessId: "biz-1",
    parentRunId: "run-parent",
    agentId: "researcher",
    task: "Summarise the open issues",
    rootAuthority: ROOT_AUTHORITY,
    requested: {},
    now: "2026-07-25T10:00:00.000Z",
    ...overrides,
  };
}

describe("DelegationCoordinator.delegate", () => {
  it("starts the child Run and records the link the Run was started under", async () => {
    const { delegation, store, started } = coordinator();

    const helper = await delegation.delegate(request());

    expect(started).toHaveLength(1);
    expect(helper.childRunId).toBe("run-child-1");
    expect(helper.conversationId).toBe("chat-1");
    expect(store.links).toHaveLength(1);
    expect(store.links[0]).toMatchObject({
      parentRunId: "run-parent",
      childRunId: "run-child-1",
    });
    expect(started[0].authority).toEqual(helper.authority);
  });

  it("offers a read-only helper only the Tools that carry no effect", async () => {
    const { delegation, started } = coordinator();

    const helper = await delegation.delegate(request());

    expect(helper.mode).toBe("read_only");
    expect(helper.authority.tools).toEqual(["github.issue.read", "knowledge.search"]);
    expect(started[0].authority.tools).not.toContain("github.issue.comment");
  });

  it("refuses a Tool the parent never held", async () => {
    const { delegation, store, started } = coordinator();

    await expect(
      delegation.delegate(request({ requested: { mode: "read_write", tools: ["billing.refund"] } }))
    ).rejects.toThrow(ChildRunError);
    expect(started).toHaveLength(0);
    expect(store.links).toHaveLength(0);
  });

  it("refuses a limit the parent never held", async () => {
    const { delegation, started } = coordinator();

    await expect(
      delegation.delegate(request({ requested: { limits: { costUsd: 50 } } }))
    ).rejects.toThrow(ChildRunError);
    expect(started).toHaveLength(0);
  });

  it("refuses a classification the parent never held", async () => {
    const { delegation, started } = coordinator();

    await expect(
      delegation.delegate(request({ requested: { classifications: ["restricted"] } }))
    ).rejects.toThrow(ChildRunError);
    expect(started).toHaveLength(0);
  });

  it("refuses a deadline later than the parent's", async () => {
    const { delegation, started } = coordinator();

    await expect(
      delegation.delegate(request({ requested: { deadlineAt: "2026-07-25T12:00:00.000Z" } }))
    ).rejects.toThrow(new DelegationError("deadline_amplification", "deadlineAt"));
    expect(started).toHaveLength(0);
  });

  it("refuses an unparseable deadline rather than treating it as inherited", async () => {
    const { delegation } = coordinator();

    await expect(
      delegation.delegate(request({ requested: { deadlineAt: "whenever" } }))
    ).rejects.toThrow(new DelegationError("deadline_amplification", "deadlineAt"));
  });

  it("refuses to start a child when the root authority names no deadline at all", async () => {
    const { delegation, started } = coordinator();

    await expect(
      delegation.delegate(
        request({
          rootAuthority: { tools: [], classifications: [], limits: {} },
        })
      )
    ).rejects.toThrow(new DelegationError("deadline_unbounded", DELEGATION_DEADLINE_LIMIT_KEY));
    expect(started).toHaveLength(0);
  });

  it("unmakes the child Run when its link cannot be recorded", async () => {
    const { delegation, store, cancelled } = coordinator();
    store.failNextLink = true;

    await expect(delegation.delegate(request())).rejects.toThrow("link_store_unavailable");

    expect(cancelled).toEqual(["run-child-1"]);
  });
});

describe("DelegationCoordinator depth", () => {
  /** Delegates once per hop, each child delegating in turn, until the guard refuses. */
  async function delegateChain(maxDepth: number, hops: number) {
    const context = coordinator({ maxDepth });
    let parentRunId = "run-parent";
    const depths: number[] = [];
    for (let hop = 0; hop < hops; hop += 1) {
      const helper = await context.delegation.delegate(request({ parentRunId }));
      depths.push(helper.depth);
      parentRunId = helper.childRunId;
    }
    return { ...context, depths, parentRunId };
  }

  it("counts depth from the persisted chain, so a child cannot restart it", async () => {
    const { depths } = await delegateChain(3, 3);

    expect(depths).toEqual([1, 2, 3]);
  });

  it("refuses the hop that would exceed the configured depth", async () => {
    const { delegation, parentRunId, started } = await delegateChain(2, 2);

    await expect(delegation.delegate(request({ parentRunId }))).rejects.toThrow(
      new DelegationError("depth_limit_exceeded", "depth")
    );
    expect(started).toHaveLength(2);
  });

  it("a chain cannot outlive the depth limit however the child asks", async () => {
    const { delegation, parentRunId } = await delegateChain(2, 2);

    for (const requested of [
      {},
      { mode: "read_write" as const, tools: ["github.issue.read"] },
      { deadlineAt: "2026-07-25T10:30:00.000Z" },
    ]) {
      await expect(delegation.delegate(request({ parentRunId, requested }))).rejects.toThrow(
        DelegationError
      );
    }
  });
});

describe("DelegationCoordinator inherited authority", () => {
  it("measures a grandchild against the link row, not against the caller's claim", async () => {
    const { delegation, started } = coordinator({ maxDepth: 3 });

    const child = await delegation.delegate(
      request({ requested: { deadlineAt: "2026-07-25T10:30:00.000Z" } })
    );
    // A wider `rootAuthority` is ignored once the parent Run has a link of its own.
    await expect(
      delegation.delegate(
        request({
          parentRunId: child.childRunId,
          rootAuthority: {
            tools: ["billing.refund"],
            classifications: ["restricted"],
            limits: { [DELEGATION_DEADLINE_LIMIT_KEY]: DEADLINE },
          },
          requested: { deadlineAt: "2026-07-25T10:45:00.000Z" },
        })
      )
    ).rejects.toThrow(new DelegationError("deadline_amplification", "deadlineAt"));

    const grandchild = await delegation.delegate(request({ parentRunId: child.childRunId }));

    expect(grandchild.authority.tools).toEqual(["github.issue.read", "knowledge.search"]);
    expect(grandchild.authority.classifications).toEqual(["confidential", "internal"]);
    expect(grandchild.deadlineAt).toBe("2026-07-25T10:30:00.000Z");
    expect(started.at(-1)?.deadlineAt).toBe("2026-07-25T10:30:00.000Z");
  });
});
