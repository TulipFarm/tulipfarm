import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable, TransactionPort } from "../ports";
import {
  KILL_SWITCH_STORAGE_STATEMENTS,
  KillSwitchRepo,
  KillSwitchStoreError,
} from "./kill-switch-repo";

const BUSINESS = "business-1";
const OTHER_BUSINESS = "business-2";

function transactionPort(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as Queryable)),
  };
}

describe("KillSwitchRepo (PostgreSQL)", () => {
  let database: PGlite;
  let repo: KillSwitchRepo;

  beforeAll(async () => {
    database = new PGlite();
    for (const sql of KILL_SWITCH_STORAGE_STATEMENTS) {
      await database.exec(sql);
    }
    repo = new KillSwitchRepo(transactionPort(database));
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec("DELETE FROM kill_switches");
  });

  it("returns an enabled switch to the guard", async () => {
    await repo.enable({
      businessId: BUSINESS,
      id: "ks-1",
      scope: { kind: "all_mutations" },
      reasonCode: "incident-42",
      enabledBy: "user-1",
    });

    const enabled = await repo.listEnabled(BUSINESS);
    expect(enabled).toHaveLength(1);
    expect(enabled[0]).toMatchObject({
      id: "ks-1",
      businessId: BUSINESS,
      scope: { kind: "all_mutations" },
      reasonCode: "incident-42",
      enabledBy: "user-1",
    });
    expect(enabled[0]?.scope.value).toBeUndefined();
  });

  it("keeps one business's switches out of another's", async () => {
    await repo.enable({
      businessId: OTHER_BUSINESS,
      id: "ks-other",
      scope: { kind: "all_mutations" },
      reasonCode: "incident-42",
      enabledBy: "user-1",
    });

    expect(await repo.listEnabled(BUSINESS)).toEqual([]);
  });

  it("treats re-enabling a live scope as the switch already holding it", async () => {
    const first = await repo.enable({
      businessId: BUSINESS,
      id: "ks-1",
      scope: { kind: "tool", value: "slack.post" },
      reasonCode: "incident-42",
      enabledBy: "user-1",
    });
    const second = await repo.enable({
      businessId: BUSINESS,
      id: "ks-2",
      scope: { kind: "tool", value: "slack.post" },
      reasonCode: "incident-43",
      enabledBy: "user-2",
    });

    expect(second.id).toBe(first.id);
    expect(await repo.listEnabled(BUSINESS)).toHaveLength(1);
  });

  it("separates switches that differ only by scope value", async () => {
    await repo.enable({
      businessId: BUSINESS,
      id: "ks-1",
      scope: { kind: "tool", value: "slack.post" },
      reasonCode: "incident-42",
      enabledBy: "user-1",
    });
    await repo.enable({
      businessId: BUSINESS,
      id: "ks-2",
      scope: { kind: "tool", value: "github.merge" },
      reasonCode: "incident-42",
      enabledBy: "user-1",
    });

    expect(await repo.listEnabled(BUSINESS)).toHaveLength(2);
  });

  it("rejects a scope value on all_mutations and a missing one elsewhere", async () => {
    await expect(
      repo.enable({
        businessId: BUSINESS,
        id: "ks-1",
        scope: { kind: "all_mutations", value: "everything" },
        reasonCode: "incident-42",
        enabledBy: "user-1",
      })
    ).rejects.toMatchObject({ code: "invalid_scope" });

    await expect(
      repo.enable({
        businessId: BUSINESS,
        id: "ks-2",
        scope: { kind: "tool" },
        reasonCode: "incident-42",
        enabledBy: "user-1",
      })
    ).rejects.toBeInstanceOf(KillSwitchStoreError);
  });

  it("retires a switch without deleting its history", async () => {
    await repo.enable({
      businessId: BUSINESS,
      id: "ks-1",
      scope: { kind: "provider", value: "slack" },
      reasonCode: "incident-42",
      enabledBy: "user-1",
    });

    const disabled = await repo.disable(BUSINESS, "ks-1", "user-2");
    expect(disabled.disabledBy).toBe("user-2");
    expect(disabled.disabledAt).toEqual(expect.any(String));

    expect(await repo.listEnabled(BUSINESS)).toEqual([]);
    expect(await repo.list(BUSINESS)).toHaveLength(1);
  });

  it("lets a retired scope be flipped again as a new switch", async () => {
    await repo.enable({
      businessId: BUSINESS,
      id: "ks-1",
      scope: { kind: "provider", value: "slack" },
      reasonCode: "incident-42",
      enabledBy: "user-1",
    });
    await repo.disable(BUSINESS, "ks-1", "user-2");
    await repo.enable({
      businessId: BUSINESS,
      id: "ks-2",
      scope: { kind: "provider", value: "slack" },
      reasonCode: "incident-99",
      enabledBy: "user-1",
    });

    expect(await repo.listEnabled(BUSINESS)).toHaveLength(1);
    expect(await repo.list(BUSINESS)).toHaveLength(2);
  });

  it("distinguishes an unknown switch from one already retired", async () => {
    await repo.enable({
      businessId: BUSINESS,
      id: "ks-1",
      scope: { kind: "provider", value: "slack" },
      reasonCode: "incident-42",
      enabledBy: "user-1",
    });
    await repo.disable(BUSINESS, "ks-1", "user-2");

    await expect(repo.disable(BUSINESS, "ks-1", "user-2")).rejects.toMatchObject({
      code: "already_disabled",
    });
    await expect(repo.disable(BUSINESS, "nope", "user-2")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("refuses to rewrite or re-enable a stored switch", async () => {
    await repo.enable({
      businessId: BUSINESS,
      id: "ks-1",
      scope: { kind: "provider", value: "slack" },
      reasonCode: "incident-42",
      enabledBy: "user-1",
    });

    await expect(
      database.exec("UPDATE kill_switches SET reason_code = 'rewritten' WHERE id = 'ks-1'")
    ).rejects.toThrow(/kill_switch_immutable/);

    await repo.disable(BUSINESS, "ks-1", "user-2");
    await expect(
      database.exec(
        "UPDATE kill_switches SET disabled_at = NULL, disabled_by = NULL WHERE id = 'ks-1'"
      )
    ).rejects.toThrow(/kill_switch_reenable_forbidden/);
  });
});
