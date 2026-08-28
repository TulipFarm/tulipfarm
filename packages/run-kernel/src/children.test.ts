import { describe, expect, it } from "vitest";
import {
  type ChildAuthority,
  type ChildAuthorityBinding,
  type ChildLink,
  type ChildLinkAncestry,
  type ChildLinkStore,
  type ChildResumeGrant,
  ChildRunError,
  ChildRunManager,
  narrowChildAuthority,
} from "./children";

const BUSINESS_ID = "business-1";
const PARENT_ID = "00000000-0000-4000-8000-000000000001";
const CHILD_ID = "00000000-0000-4000-8000-000000000002";

const PARENT: ChildAuthority = {
  tools: ["crm.read", "crm.write"],
  classifications: ["internal", "public"],
  limits: { tokens: 1_000, sideEffects: 5 },
};

class FakeChildLinkStore implements ChildLinkStore {
  readonly links: ChildLink[] = [];

  async link(input: {
    businessId: string;
    parentRunId: string;
    childRunId: string;
    authority: ChildAuthority;
    authorityBinding?: ChildAuthorityBinding;
    resume?: ChildResumeGrant;
    callId?: string;
    createdAt: string;
  }): Promise<ChildLink> {
    const existing = this.links.find(
      (link) => link.parentRunId === input.parentRunId && link.childRunId === input.childRunId
    );
    // Re-linking after a crash keeps the originally narrowed authority.
    if (existing) return existing;
    const created: ChildLink = {
      parentRunId: input.parentRunId,
      childRunId: input.childRunId,
      authority: input.authority,
      authorityBinding: input.authorityBinding ?? "delegated",
      callId: input.callId ?? null,
      resume: input.resume ?? null,
      detachedAt: null,
      createdAt: input.createdAt,
    };
    this.links.push(created);
    return created;
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
    if (index === -1 || this.links[index].detachedAt !== null) return false;
    this.links[index] = { ...this.links[index], detachedAt };
    return true;
  }

  async listChildren(_businessId: string, parentRunId: string): Promise<readonly ChildLink[]> {
    return this.links.filter((link) => link.parentRunId === parentRunId);
  }
}

function ancestryOf(store: FakeChildLinkStore): ChildLinkAncestry {
  return {
    parentLink: async (_businessId, childRunId) =>
      store.links.find((link) => link.childRunId === childRunId) ?? null,
  };
}

describe("narrowChildAuthority", () => {
  it("inherits the parent's authority when the child requests nothing", () => {
    expect(narrowChildAuthority(PARENT, {})).toEqual(PARENT);
  });

  it("narrows every dimension the child asks to restrict", () => {
    expect(
      narrowChildAuthority(PARENT, {
        tools: ["crm.read"],
        classifications: ["public"],
        limits: { tokens: 100 },
      })
    ).toEqual({
      tools: ["crm.read"],
      classifications: ["public"],
      limits: { tokens: 100, sideEffects: 5 },
    });
  });

  it("denies a Tool the parent does not hold instead of silently granting it", () => {
    expect(() => narrowChildAuthority(PARENT, { tools: ["crm.read", "billing.refund"] })).toThrow(
      new ChildRunError("child_authority_amplification", "tools")
    );
  });

  it("denies a classification the parent cannot read", () => {
    expect(() => narrowChildAuthority(PARENT, { classifications: ["restricted"] })).toThrow(
      new ChildRunError("child_authority_amplification", "classifications")
    );
  });

  it("denies a limit the child tries to raise above the parent's ceiling", () => {
    expect(() => narrowChildAuthority(PARENT, { limits: { tokens: 1_001 } })).toThrow(
      new ChildRunError("child_authority_amplification", "tokens")
    );
  });

  it("denies a limit key the parent never declared, so a child cannot invent budget", () => {
    expect(() => narrowChildAuthority(PARENT, { limits: { costMicros: 10 } })).toThrow(
      new ChildRunError("child_authority_amplification", "costMicros")
    );
  });

  it("orders narrowed grants deterministically so evidence is comparable", () => {
    const narrowed = narrowChildAuthority(PARENT, { tools: ["crm.write", "crm.read"] });

    expect(narrowed.tools).toEqual(["crm.read", "crm.write"]);
  });
});

describe("ChildRunManager", () => {
  const spawn = (manager: ChildRunManager, requested: Partial<ChildAuthority> = {}) =>
    manager.spawn({
      businessId: BUSINESS_ID,
      parentRunId: PARENT_ID,
      childRunId: CHILD_ID,
      parentAuthority: PARENT,
      requestedAuthority: requested,
      now: "2026-07-25T10:00:00.000Z",
    });

  it("persists the narrowed authority, never the requested one", async () => {
    const store = new FakeChildLinkStore();

    const link = await spawn(new ChildRunManager(store, ancestryOf(store)), {
      tools: ["crm.read"],
    });

    expect(link.authority).toEqual({
      tools: ["crm.read"],
      classifications: ["internal", "public"],
      limits: { tokens: 1_000, sideEffects: 5 },
    });
    expect(store.links).toHaveLength(1);
  });

  it("refuses to persist a link when the child asked to broaden authority", async () => {
    const store = new FakeChildLinkStore();

    await expect(
      spawn(new ChildRunManager(store, ancestryOf(store)), { tools: ["billing.refund"] })
    ).rejects.toThrow(ChildRunError);
    expect(store.links).toHaveLength(0);
  });

  it("is idempotent so a retried spawn cannot re-widen an existing link", async () => {
    const store = new FakeChildLinkStore();
    const manager = new ChildRunManager(store, ancestryOf(store));

    await spawn(manager, { tools: ["crm.read"] });
    const again = await spawn(manager, {});

    expect(again.authority.tools).toEqual(["crm.read"]);
    expect(store.links).toHaveLength(1);
  });

  it("detaches a child explicitly and records when it happened", async () => {
    const store = new FakeChildLinkStore();
    const manager = new ChildRunManager(store, ancestryOf(store));
    await spawn(manager, {});

    const detached = await manager.detach({
      businessId: BUSINESS_ID,
      parentRunId: PARENT_ID,
      childRunId: CHILD_ID,
      now: "2026-07-25T10:01:00.000Z",
    });

    expect(detached).toBe(true);
    const [link] = await manager.listChildren(BUSINESS_ID, PARENT_ID);
    expect(link.detachedAt).toBe("2026-07-25T10:01:00.000Z");
  });

  it("reports a second detach as a no-op rather than failing the caller", async () => {
    const store = new FakeChildLinkStore();
    const manager = new ChildRunManager(store, ancestryOf(store));
    await spawn(manager, {});
    const detach = () =>
      manager.detach({
        businessId: BUSINESS_ID,
        parentRunId: PARENT_ID,
        childRunId: CHILD_ID,
        now: "2026-07-25T10:01:00.000Z",
      });

    await detach();

    expect(await detach()).toBe(false);
  });

  it("rejects a Run that would be its own child", async () => {
    const manager = new ChildRunManager(
      new FakeChildLinkStore(),
      ancestryOf(new FakeChildLinkStore())
    );

    await expect(
      manager.spawn({
        businessId: BUSINESS_ID,
        parentRunId: PARENT_ID,
        childRunId: PARENT_ID,
        parentAuthority: PARENT,
        requestedAuthority: {},
        now: "2026-07-25T10:00:00.000Z",
      })
    ).rejects.toThrow(new ChildRunError("child_self_link", "childRunId"));
  });
});

describe("ChildRunManager.ancestors", () => {
  const chainId = (n: number) => `00000000-0000-4000-8000-00000000010${n}`;

  async function chain(depth: number): Promise<ChildRunManager> {
    const store = new FakeChildLinkStore();
    const manager = new ChildRunManager(store, ancestryOf(store));
    for (let i = 0; i < depth; i += 1) {
      await manager.spawn({
        businessId: BUSINESS_ID,
        parentRunId: chainId(i),
        childRunId: chainId(i + 1),
        parentAuthority: PARENT,
        requestedAuthority: {},
        now: "2026-07-25T10:00:00.000Z",
      });
    }
    return manager;
  }

  it("reads the persisted chain nearest parent first", async () => {
    const manager = await chain(3);

    const ancestors = await manager.ancestors(BUSINESS_ID, chainId(3), 10);

    expect(ancestors.map((link) => link.parentRunId)).toEqual([chainId(2), chainId(1), chainId(0)]);
  });

  it("returns no ancestors for an unlinked root Run", async () => {
    const manager = await chain(0);

    expect(await manager.ancestors(BUSINESS_ID, chainId(0), 10)).toEqual([]);
  });

  it("stops at the requested limit rather than walking the whole history", async () => {
    const manager = await chain(5);

    expect(await manager.ancestors(BUSINESS_ID, chainId(5), 2)).toHaveLength(2);
  });

  it("terminates on a cyclic link rather than looping forever", async () => {
    const store = new FakeChildLinkStore();
    const manager = new ChildRunManager(store, ancestryOf(store));
    store.links.push(
      {
        parentRunId: chainId(1),
        childRunId: chainId(0),
        authority: PARENT,
        authorityBinding: "delegated",
        callId: null,
        resume: null,
        detachedAt: null,
        createdAt: "2026-07-25T10:00:00.000Z",
      },
      {
        parentRunId: chainId(0),
        childRunId: chainId(1),
        authority: PARENT,
        authorityBinding: "delegated",
        callId: null,
        resume: null,
        detachedAt: null,
        createdAt: "2026-07-25T10:00:00.000Z",
      }
    );

    // Stops at the first repeat rather than walking the cycle up to the limit.
    const ancestors = await manager.ancestors(BUSINESS_ID, chainId(0), 100);
    expect(ancestors.map((link) => link.parentRunId)).toEqual([chainId(1)]);
  });
});
