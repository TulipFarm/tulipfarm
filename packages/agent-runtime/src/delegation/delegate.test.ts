import {
  type ChildAuthority,
  type ChildLink,
  type ChildLinkStore,
  ChildRunError,
  ChildRunManager,
} from "@tulipfarm/run-kernel";
import { describe, expect, it } from "vitest";
import { DelegationCoordinator, type DelegationError, type DelegationRequest } from "./delegate";

class FakeChildLinkStore implements ChildLinkStore {
  links: ChildLink[] = [];

  async link(input: {
    parentRunId: string;
    childRunId: string;
    authority: ChildAuthority;
    createdAt: string;
  }): Promise<ChildLink> {
    const link: ChildLink = {
      parentRunId: input.parentRunId,
      childRunId: input.childRunId,
      authority: input.authority,
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

const PARENT_AUTHORITY: ChildAuthority = {
  tools: ["github.issue.read", "github.issue.comment", "knowledge.search"],
  classifications: ["internal", "confidential"],
  limits: { toolCalls: 20, costUsd: 5 },
};

const READ_ONLY_TOOLS = new Set(["github.issue.read", "knowledge.search"]);

function coordinator(options: { maxDepth?: number } = {}) {
  const store = new FakeChildLinkStore();
  const delegation = new DelegationCoordinator({
    children: new ChildRunManager(store),
    tools: { isReadOnly: (name: string) => READ_ONLY_TOOLS.has(name) },
    policy: { maxDepth: options.maxDepth ?? 2 },
  });
  return { delegation, store };
}

function request(overrides: Partial<DelegationRequest> = {}): DelegationRequest {
  return {
    businessId: "biz-1",
    parentRunId: "run-parent",
    childRunId: "run-child",
    parent: {
      authority: PARENT_AUTHORITY,
      depth: 0,
      deadlineAt: "2026-07-25T11:00:00.000Z",
    },
    requested: {},
    now: "2026-07-25T10:00:00.000Z",
    ...overrides,
  };
}

describe("DelegationCoordinator", () => {
  it("starts a helper read-only, dropping the parent's effect-bearing Tools", async () => {
    const { delegation } = coordinator();
    const helper = await delegation.delegate(request());

    expect(helper.authority.tools).toEqual(["github.issue.read", "knowledge.search"]);
    expect(helper.mode).toBe("read_only");
    expect(helper.depth).toBe(1);
  });

  it("grants an effect-bearing Tool only when the helper explicitly asks and the parent holds it", async () => {
    const { delegation } = coordinator();
    const helper = await delegation.delegate(
      request({
        requested: { mode: "read_write", tools: ["github.issue.comment"] },
      })
    );

    expect(helper.authority.tools).toEqual(["github.issue.comment"]);
    expect(helper.mode).toBe("read_write");
  });

  it("denies a Tool the parent never held", async () => {
    const { delegation, store } = coordinator();

    await expect(
      delegation.delegate(
        request({ requested: { mode: "read_write", tools: ["github.repo.delete"] } })
      )
    ).rejects.toBeInstanceOf(ChildRunError);
    expect(store.links).toEqual([]);
  });

  it("denies a budget above the parent's ceiling", async () => {
    const { delegation } = coordinator();

    await expect(
      delegation.delegate(request({ requested: { limits: { costUsd: 50 } } }))
    ).rejects.toBeInstanceOf(ChildRunError);
  });

  it("denies a classification the parent cannot see", async () => {
    const { delegation } = coordinator();

    await expect(
      delegation.delegate(request({ requested: { classifications: ["restricted"] } }))
    ).rejects.toBeInstanceOf(ChildRunError);
  });

  it("denies a deadline later than the parent's and keeps an earlier one", async () => {
    const { delegation, store } = coordinator();

    await expect(
      delegation.delegate(request({ requested: { deadlineAt: "2026-07-25T23:00:00.000Z" } }))
    ).rejects.toMatchObject({ code: "deadline_amplification" });
    expect(store.links).toEqual([]);

    const helper = await delegation.delegate(
      request({ requested: { deadlineAt: "2026-07-25T10:30:00.000Z" } })
    );
    expect(helper.deadlineAt).toBe("2026-07-25T10:30:00.000Z");
  });

  it("refuses to delegate past the configured depth", async () => {
    const { delegation, store } = coordinator({ maxDepth: 1 });

    await expect(
      delegation.delegate(request({ parent: { ...request().parent, depth: 1 } }))
    ).rejects.toMatchObject({ code: "depth_limit_exceeded" });
    expect(store.links).toEqual([]);
  });

  it("propagates cancellation to attached helpers only", async () => {
    const { delegation } = coordinator();
    await delegation.delegate(request());
    await delegation.delegate(request({ childRunId: "run-child-2" }));
    await delegation.detach({
      businessId: "biz-1",
      parentRunId: "run-parent",
      childRunId: "run-child-2",
      now: "2026-07-25T10:05:00.000Z",
    });

    expect(await delegation.cancellationTargets("biz-1", "run-parent")).toEqual(["run-child"]);
  });

  it("accepts a helper Artifact only when it matches the declared schema", async () => {
    const { delegation } = coordinator();
    const schema = {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
    };

    const accepted = delegation.acceptArtifact({
      childRunId: "run-child",
      schemaRef: "helper.summary.v1",
      schema,
      value: { summary: "no regressions found" },
    });
    expect(accepted).toMatchObject({
      outcome: "accepted",
      artifact: { childRunId: "run-child", schemaRef: "helper.summary.v1" },
    });

    expect(
      delegation.acceptArtifact({
        childRunId: "run-child",
        schemaRef: "helper.summary.v1",
        schema,
        value: { summary: 42 },
      })
    ).toMatchObject({ outcome: "rejected", reason: "artifact_schema_mismatch" });
  });

  it("records the narrowed authority on the durable link, not the requested one", async () => {
    const { delegation, store } = coordinator();
    await delegation.delegate(request({ requested: { limits: { toolCalls: 3 } } }));

    expect(store.links[0]?.authority).toMatchObject({
      tools: ["github.issue.read", "knowledge.search"],
      limits: { toolCalls: 3, costUsd: 5 },
    });
  });
});

// Type-only guard: the error union stays a closed set of reason codes.
const _codes: DelegationError["code"][] = ["depth_limit_exceeded", "deadline_amplification"];
