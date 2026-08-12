import { InMemoryAuditEventRepo, verifyChain } from "@tulipfarm/audit";
import { describe, expect, it } from "vitest";
import { AuditService, SYSTEM_PRINCIPAL_ID } from "./service";

const BUSINESS = "biz-test";

function service(repo = new InMemoryAuditEventRepo(), log: (m: string) => void = () => {}) {
  return { svc: new AuditService(repo, BUSINESS, log), repo };
}

describe("AuditService", () => {
  it("attributes an event to the acting user", async () => {
    const { svc, repo } = service();

    await svc.record({ actorId: "user-9", action: "resource-type.create", target: "rt:ticket" });

    const [event] = await repo.listChain(BUSINESS);
    expect(event?.actor).toEqual({ principalId: "user-9", businessId: BUSINESS });
    expect(event?.effectivePrincipal.principalId).toBe("user-9");
    expect(event?.decision).toBe("allow");
  });

  it("attributes an unauthenticated change to the system rather than dropping it", async () => {
    const { svc, repo } = service();

    await svc.record({ actorId: null, action: "soul.reload", target: "soul" });

    expect((await repo.listChain(BUSINESS))[0]?.actor.principalId).toBe(SYSTEM_PRINCIPAL_ID);
  });

  it("separates the effective principal from the actor when an agent acts for a user", async () => {
    const { svc, repo } = service();

    await svc.record({
      actorId: "user-1",
      effectivePrincipalId: "agent-7",
      action: "tool.invoke",
      target: "github:issue",
    });

    const [event] = await repo.listChain(BUSINESS);
    expect(event?.actor.principalId).toBe("user-1");
    expect(event?.effectivePrincipal.principalId).toBe("agent-7");
  });

  it("chains successive events into a verifiable ledger", async () => {
    const { svc, repo } = service();

    for (const n of [1, 2, 3]) {
      await svc.record({ actorId: "u", action: "a", target: `t${n}` });
    }

    const chain = await repo.listChain(BUSINESS);
    expect(chain.map((e) => e.chainIndex)).toEqual([0, 1, 2]);
    expect(verifyChain(chain).issues).toEqual([]);
  });

  it("rejects protected payloads instead of writing secrets into the ledger", async () => {
    const { svc } = service();

    await expect(
      svc.record({ actorId: "u", action: "a", target: "t", safeMetadata: { token: "abc" } })
    ).rejects.toThrow();
  });

  it("throws from record, so an audit failure cannot pass unnoticed", async () => {
    const failing = new InMemoryAuditEventRepo();
    failing.append = async () => {
      throw new Error("database is down");
    };

    await expect(
      new AuditService(failing, BUSINESS).record({ actorId: "u", action: "a", target: "t" })
    ).rejects.toThrow(/database is down/);
  });

  it("logs loudly from recordOrWarn rather than failing an already-committed change", async () => {
    const failing = new InMemoryAuditEventRepo();
    failing.append = async () => {
      throw new Error("database is down");
    };
    const logged: string[] = [];

    await new AuditService(failing, BUSINESS, (m) => logged.push(m)).recordOrWarn({
      actorId: "u",
      action: "resource-type.delete",
      target: "rt:ticket",
    });

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("FAILED");
    expect(logged[0]).toContain("resource-type.delete");
  });
});
