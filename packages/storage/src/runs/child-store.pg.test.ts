import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable, TransactionPort } from "../ports";
import { CHILD_STORAGE_STATEMENTS, ChildLinkStore } from "./child-store";
import { RUN_STORAGE_STATEMENTS, RunStore, type StartRunInput } from "./run-store";

const BUSINESS = "business-1";
const PARENT_ID = "00000000-0000-4000-8000-000000000001";
const CHILD_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_CHILD_ID = "00000000-0000-4000-8000-000000000003";
const CREATED_AT = "2026-07-25T10:00:00.000Z";
const DETACHED_AT = "2026-07-25T10:05:00.000Z";

const AUTHORITY = {
  tools: ["crm.read"],
  classifications: ["internal"],
  limits: { tokens: 100 },
};

function transactionPort(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as Queryable)),
  };
}

function run(id: string): StartRunInput {
  return {
    id,
    businessId: BUSINESS,
    source: "routine",
    bundle: { digest: "sha256:bundle-1", routineId: "routine-1", routineVersion: "1" },
    identity: {
      initiator: { kind: "user", id: "user-1" },
      effectiveSubject: { kind: "agent", id: "agent-1" },
      guardrailContextRef: "guardrail-context-1",
    },
    createdAt: CREATED_AT,
    states: [{ key: "apply", definitionRef: "sha256:bundle-1#/states/apply", resolvedInput: {} }],
  };
}

describe("ChildLinkStore", () => {
  let database: PGlite;
  let store: ChildLinkStore;
  let runs: RunStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of [...RUN_STORAGE_STATEMENTS, ...CHILD_STORAGE_STATEMENTS]) {
      await database.exec(statement);
    }
    const transactions = transactionPort(database);
    store = new ChildLinkStore(transactions);
    runs = new RunStore(transactions);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.query("TRUNCATE TABLE runs CASCADE");
    for (const id of [PARENT_ID, CHILD_ID, OTHER_CHILD_ID]) {
      await runs.start(run(id));
    }
  });

  const link = (childRunId = CHILD_ID) =>
    store.link({
      businessId: BUSINESS,
      parentRunId: PARENT_ID,
      childRunId,
      authority: AUTHORITY,
      createdAt: CREATED_AT,
    });

  it("persists the narrowed authority a child Run was linked with", async () => {
    const created = await link();

    expect(created).toEqual({
      parentRunId: PARENT_ID,
      childRunId: CHILD_ID,
      authority: AUTHORITY,
      detachedAt: null,
      createdAt: CREATED_AT,
    });
  });

  it("keeps the original authority when a crashed spawn re-links the same child", async () => {
    await link();

    const again = await store.link({
      businessId: BUSINESS,
      parentRunId: PARENT_ID,
      childRunId: CHILD_ID,
      authority: { tools: ["crm.read", "crm.write"], classifications: ["restricted"], limits: {} },
      createdAt: "2026-07-25T11:00:00.000Z",
    });

    expect(again.authority).toEqual(AUTHORITY);
    expect(again.createdAt).toBe(CREATED_AT);
  });

  it("detaches a child once and reports a repeat detach as a no-op", async () => {
    await link();

    expect(await store.detach(BUSINESS, PARENT_ID, CHILD_ID, DETACHED_AT)).toBe(true);
    expect(await store.detach(BUSINESS, PARENT_ID, CHILD_ID, DETACHED_AT)).toBe(false);
    const links = await store.listChildren(BUSINESS, PARENT_ID);
    expect(links[0].detachedAt).toBe(DETACHED_AT);
  });

  it("lists children in deterministic order for both attached and detached links", async () => {
    await link();
    await link(OTHER_CHILD_ID);
    await store.detach(BUSINESS, PARENT_ID, OTHER_CHILD_ID, DETACHED_AT);

    const links = await store.listChildren(BUSINESS, PARENT_ID);

    expect(links.map((entry) => entry.childRunId)).toEqual([CHILD_ID, OTHER_CHILD_ID]);
    expect(links.map((entry) => entry.detachedAt)).toEqual([null, DETACHED_AT]);
  });

  it("refuses a link between Runs of different businesses", async () => {
    await expect(
      store.link({
        businessId: "business-2",
        parentRunId: PARENT_ID,
        childRunId: CHILD_ID,
        authority: AUTHORITY,
        createdAt: CREATED_AT,
      })
    ).rejects.toThrow();
  });

  it("refuses a Run linked as its own child", async () => {
    await expect(
      store.link({
        businessId: BUSINESS,
        parentRunId: PARENT_ID,
        childRunId: PARENT_ID,
        authority: AUTHORITY,
        createdAt: CREATED_AT,
      })
    ).rejects.toThrow();
  });

  it("refuses to re-attach a detached child, so detach is final", async () => {
    await link();
    await store.detach(BUSINESS, PARENT_ID, CHILD_ID, DETACHED_AT);

    await expect(
      database.exec(
        `UPDATE run_child_links SET detached_at = NULL WHERE child_run_id = '${CHILD_ID}'`
      )
    ).rejects.toThrow(/run_child_link_detach_final/);
  });

  it("refuses to widen a persisted authority in place", async () => {
    await link();

    await expect(
      database.exec(
        `UPDATE run_child_links SET authority = '{"tools":["*"]}'::jsonb WHERE child_run_id = '${CHILD_ID}'`
      )
    ).rejects.toThrow(/run_child_link_authority_immutable/);
  });
});
