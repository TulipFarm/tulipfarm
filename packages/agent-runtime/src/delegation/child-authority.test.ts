import type {
  ChildAuthority,
  ChildAuthorityBinding,
  ChildLink,
  ChildLinkAncestry,
} from "@tulipfarm/run-kernel";
import { describe, expect, it } from "vitest";
import {
  ChildAuthorityError,
  delegatedCallRefusal,
  narrowDelegatedLimits,
  narrowDelegatedTools,
  narrowDelegatedTurn,
  resolveDelegatedBound,
  UNLINKED_RUN,
  withDelegatedAuthority,
} from "./child-authority";
import { DELEGATION_DEADLINE_LIMIT_KEY } from "./delegate";

const BUSINESS = "biz";
const DEADLINE_MS = Date.parse("2026-01-01T00:10:00.000Z");
const NOW_MS = Date.parse("2026-01-01T00:00:00.000Z");

function authority(overrides: Partial<ChildAuthority> = {}): ChildAuthority {
  return {
    tools: ["record_list", "knowledge_search"],
    classifications: ["business_record"],
    limits: { [DELEGATION_DEADLINE_LIMIT_KEY]: DEADLINE_MS },
    ...overrides,
  };
}

function linkedTo(
  granted: ChildAuthority,
  runId = "child",
  binding: ChildAuthorityBinding = "delegated"
): ChildLinkAncestry {
  return {
    parentLink: async (_businessId, childRunId): Promise<ChildLink | null> =>
      childRunId !== runId
        ? null
        : {
            parentRunId: "parent",
            childRunId,
            authority: granted,
            authorityBinding: binding,
            resume: null,
            callId: null,
            detachedAt: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
  };
}

const UNREADABLE: ChildLinkAncestry = {
  parentLink: async () => {
    throw new Error("connection terminated");
  },
};

describe("resolveDelegatedBound", () => {
  it("reports a Run with no parent link as unlinked", async () => {
    const bound = await resolveDelegatedBound(linkedTo(authority()), BUSINESS, "root");

    expect(bound).toEqual(UNLINKED_RUN);
  });

  it("reads the granted authority from the link row", async () => {
    const bound = await resolveDelegatedBound(linkedTo(authority()), BUSINESS, "child");

    expect(bound).toEqual({ linked: true, authority: authority() });
  });

  it("refuses rather than falling back when the link row cannot be read", async () => {
    await expect(resolveDelegatedBound(UNREADABLE, BUSINESS, "child")).rejects.toBeInstanceOf(
      ChildAuthorityError
    );
    await expect(resolveDelegatedBound(UNREADABLE, BUSINESS, "child")).rejects.toMatchObject({
      code: "link_unreadable",
    });
  });

  it("reports a lineage link as unlinked so a child Routine keeps its own authority", async () => {
    const bound = await resolveDelegatedBound(
      linkedTo(authority(), "child", "lineage"),
      BUSINESS,
      "child"
    );

    expect(bound).toEqual(UNLINKED_RUN);
  });
});

describe("narrowDelegatedTools", () => {
  const offered = [{ name: "record_list" }, { name: "record_create" }, { name: "send_email" }];

  it("drops a Tool the Agent config offers that the link row never granted", () => {
    const narrowed = narrowDelegatedTools(offered, { linked: true, authority: authority() });

    expect(narrowed.map((tool) => tool.name)).toEqual(["record_list"]);
  });

  it("does not manufacture a Tool the link row grants but the Agent config never offered", () => {
    const narrowed = narrowDelegatedTools(offered, {
      linked: true,
      authority: authority({ tools: ["knowledge_search"] }),
    });

    expect(narrowed).toEqual([]);
  });

  it("leaves an unlinked Run exactly as its Agent config offered it", () => {
    expect(narrowDelegatedTools(offered, UNLINKED_RUN)).toBe(offered);
  });

  it("narrows monotonically down a chain, so a grandchild cannot exceed its grandparent", () => {
    const grandparent = ["record_list", "knowledge_search", "task_list"];
    const child = narrowDelegatedTools(
      grandparent.map((name) => ({ name })),
      { linked: true, authority: authority({ tools: ["record_list", "knowledge_search"] }) }
    );
    // The grandchild's own config asks for everything the grandparent held.
    const grandchild = narrowDelegatedTools(
      grandparent.map((name) => ({ name })),
      { linked: true, authority: authority({ tools: ["record_list"] }) }
    );

    expect(child.map((tool) => tool.name)).toEqual(["record_list", "knowledge_search"]);
    expect(grandchild.map((tool) => tool.name)).toEqual(["record_list"]);
    for (const tool of grandchild) {
      expect(child.map((entry) => entry.name)).toContain(tool.name);
    }
  });
});

describe("narrowDelegatedLimits", () => {
  it("clamps a turn limit to the ceiling the grant carries", () => {
    const narrowed = narrowDelegatedLimits(
      { maxToolCalls: 12, maxIterations: 12 },
      { linked: true, authority: authority({ limits: { maxToolCalls: 3 } }) }
    );

    expect(narrowed).toEqual({ maxToolCalls: 3, maxIterations: 12 });
  });

  it("never raises a limit the grant states more generously", () => {
    const narrowed = narrowDelegatedLimits(
      { maxToolCalls: 4 },
      { linked: true, authority: authority({ limits: { maxToolCalls: 99 } }) }
    );

    expect(narrowed).toEqual({ maxToolCalls: 4 });
  });

  it("leaves an unlinked Run's limits alone", () => {
    const limits = { maxToolCalls: 12 };

    expect(narrowDelegatedLimits(limits, UNLINKED_RUN)).toBe(limits);
  });
});

describe("delegatedCallRefusal", () => {
  const call = { toolName: "record_list", dataClasses: ["business_record"], nowMs: NOW_MS };

  it("allows a call inside the grant", () => {
    expect(delegatedCallRefusal({ linked: true, authority: authority() }, call)).toBeUndefined();
  });

  it("refuses a Tool the grant never held", () => {
    expect(
      delegatedCallRefusal(
        { linked: true, authority: authority() },
        {
          ...call,
          toolName: "record_create",
        }
      )
    ).toMatch(/outside the authority/);
  });

  it("refuses a data class the grant never held", () => {
    expect(
      delegatedCallRefusal(
        { linked: true, authority: authority() },
        { ...call, dataClasses: ["pii"] }
      )
    ).toMatch(/"pii" data/);
  });

  it("refuses a call made after the delegation deadline", () => {
    expect(
      delegatedCallRefusal(
        { linked: true, authority: authority() },
        {
          ...call,
          nowMs: DEADLINE_MS + 1,
        }
      )
    ).toMatch(/deadline/);
  });

  it("refuses a linked Run whose grant carries no deadline at all", () => {
    expect(
      delegatedCallRefusal({ linked: true, authority: authority({ limits: {} }) }, call)
    ).toMatch(/no deadline/);
  });

  it("bounds nothing on an unlinked Run", () => {
    expect(delegatedCallRefusal(UNLINKED_RUN, { ...call, toolName: "anything" })).toBeUndefined();
  });
});

describe("narrowDelegatedTurn", () => {
  const turn = {
    tools: [{ name: "record_list" }, { name: "record_create" }],
    limits: { maxToolCalls: 12 },
  };

  it("applies both halves of the bound in one read", async () => {
    const narrowed = await narrowDelegatedTurn(
      linkedTo(
        authority({ limits: { maxToolCalls: 2, [DELEGATION_DEADLINE_LIMIT_KEY]: DEADLINE_MS } })
      ),
      { businessId: BUSINESS, runId: "child" },
      turn
    );

    expect(narrowed.tools.map((tool) => tool.name)).toEqual(["record_list"]);
    expect(narrowed.limits).toEqual({ maxToolCalls: 2 });
  });

  it("leaves an unlinked Run untouched", async () => {
    const narrowed = await narrowDelegatedTurn(
      linkedTo(authority()),
      { businessId: BUSINESS, runId: "root" },
      turn
    );

    expect(narrowed.tools).toBe(turn.tools);
    expect(narrowed.limits).toBe(turn.limits);
  });

  it("refuses a turn whose link row cannot be read", async () => {
    await expect(
      narrowDelegatedTurn(UNREADABLE, { businessId: BUSINESS, runId: "child" }, turn)
    ).rejects.toMatchObject({ code: "link_unreadable" });
  });

  it("treats a deployment without delegation as unlinked", async () => {
    const narrowed = await narrowDelegatedTurn(
      undefined,
      { businessId: BUSINESS, runId: "child" },
      turn
    );

    expect(narrowed.tools).toBe(turn.tools);
  });
});

describe("withDelegatedAuthority", () => {
  const catalog = () => [
    { name: "record_list", mutating: false, dataClasses: ["business_record"] },
    { name: "record_create", mutating: true, dataClasses: ["business_record"] },
  ];
  const child = { businessId: BUSINESS, runId: "child" };

  function guarded(links: ChildLinkAncestry, nowMs = NOW_MS) {
    const dispatched: string[] = [];
    const guard = withDelegatedAuthority(
      { links, catalog, now: () => new Date(nowMs) },
      {
        dispatch: async (_authority: typeof child, call: { name: string }) => {
          dispatched.push(call.name);
          return { status: "succeeded" as const, output: call.name };
        },
      }
    );
    return { guard, dispatched };
  }

  it("denies a Tool the child's own Agent config offers but the grant never held", async () => {
    const { guard, dispatched } = guarded(linkedTo(authority()));

    const result = await guard.dispatch(child, { name: "record_create" });

    expect(result).toEqual({
      status: "denied",
      reason: 'tool "record_create" is outside the authority this Run was delegated',
    });
    expect(dispatched).toEqual([]);
  });

  it("passes a call inside the grant through to the inner dispatcher", async () => {
    const { guard, dispatched } = guarded(linkedTo(authority()));

    const result = await guard.dispatch(child, { name: "record_list" });

    expect(result).toEqual({ status: "succeeded", output: "record_list" });
    expect(dispatched).toEqual(["record_list"]);
  });

  it("denies after the delegation deadline even for a granted Tool", async () => {
    const { guard, dispatched } = guarded(linkedTo(authority()), DEADLINE_MS + 1);

    const result = await guard.dispatch(child, { name: "record_list" });

    expect(result).toMatchObject({ status: "denied" });
    expect(dispatched).toEqual([]);
  });

  it("denies rather than falling back to the Agent config when the link row is unreadable", async () => {
    const { guard, dispatched } = guarded(UNREADABLE);

    const result = await guard.dispatch(child, { name: "record_list" });

    expect(result).toEqual({
      status: "denied",
      reason: 'tool "record_list" could not be checked against this Run\'s delegated authority',
    });
    expect(dispatched).toEqual([]);
  });

  it("leaves an unlinked Run dispatching exactly as before", async () => {
    const { guard, dispatched } = guarded(linkedTo(authority()));

    const result = await guard.dispatch(
      { businessId: BUSINESS, runId: "root" },
      { name: "record_create" }
    );

    expect(result).toEqual({ status: "succeeded", output: "record_create" });
    expect(dispatched).toEqual(["record_create"]);
  });

  it("stops a grandchild from exceeding its grandparent", async () => {
    const grandchild = { businessId: BUSINESS, runId: "grandchild" };
    const { guard, dispatched } = guarded(
      linkedTo(authority({ tools: ["knowledge_search"] }), "grandchild")
    );

    const result = await guard.dispatch(grandchild, { name: "record_list" });

    expect(result).toMatchObject({ status: "denied" });
    expect(dispatched).toEqual([]);
  });
});
