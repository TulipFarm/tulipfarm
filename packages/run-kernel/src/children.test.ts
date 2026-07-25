import { describe, expect, it } from "vitest";
import {
  type ChildAuthority,
  type ChildLink,
  type ChildLinkStore,
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

    const link = await spawn(new ChildRunManager(store), { tools: ["crm.read"] });

    expect(link.authority).toEqual({
      tools: ["crm.read"],
      classifications: ["internal", "public"],
      limits: { tokens: 1_000, sideEffects: 5 },
    });
    expect(store.links).toHaveLength(1);
  });

  it("refuses to persist a link when the child asked to broaden authority", async () => {
    const store = new FakeChildLinkStore();

    await expect(spawn(new ChildRunManager(store), { tools: ["billing.refund"] })).rejects.toThrow(
      ChildRunError
    );
    expect(store.links).toHaveLength(0);
  });

  it("is idempotent so a retried spawn cannot re-widen an existing link", async () => {
    const store = new FakeChildLinkStore();
    const manager = new ChildRunManager(store);

    await spawn(manager, { tools: ["crm.read"] });
    const again = await spawn(manager, {});

    expect(again.authority.tools).toEqual(["crm.read"]);
    expect(store.links).toHaveLength(1);
  });

  it("detaches a child explicitly and excludes it from attached children", async () => {
    const store = new FakeChildLinkStore();
    const manager = new ChildRunManager(store);
    await spawn(manager, {});

    const detached = await manager.detach({
      businessId: BUSINESS_ID,
      parentRunId: PARENT_ID,
      childRunId: CHILD_ID,
      now: "2026-07-25T10:01:00.000Z",
    });

    expect(detached).toBe(true);
    expect(await manager.listAttached(BUSINESS_ID, PARENT_ID)).toEqual([]);
    expect(await manager.listChildren(BUSINESS_ID, PARENT_ID)).toHaveLength(1);
  });

  it("reports a second detach as a no-op rather than failing the caller", async () => {
    const store = new FakeChildLinkStore();
    const manager = new ChildRunManager(store);
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
    const manager = new ChildRunManager(new FakeChildLinkStore());

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
