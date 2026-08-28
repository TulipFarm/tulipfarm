import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable, TransactionPort } from "../ports";
import { CHILD_STORAGE_STATEMENTS, ChildLinkAncestryStore, ChildLinkStore } from "./child-store";
import { RUN_STORAGE_STATEMENTS, RunStore, type StartRunInput } from "./run-store";
import { WAIT_STORAGE_STATEMENTS, WaitStore } from "./wait-store";

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
  let waits: WaitStore;
  let ancestry: ChildLinkAncestryStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of [
      ...RUN_STORAGE_STATEMENTS,
      ...CHILD_STORAGE_STATEMENTS,
      ...WAIT_STORAGE_STATEMENTS,
    ]) {
      await database.exec(statement);
    }
    const transactions = transactionPort(database);
    store = new ChildLinkStore(transactions);
    runs = new RunStore(transactions);
    waits = new WaitStore(transactions);
    ancestry = new ChildLinkAncestryStore({
      query: (text, values) => database.query(text, values as unknown[]) as never,
    });
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
      authorityBinding: "delegated",
      resume: null,
      callId: null,
      detachedAt: null,
      createdAt: CREATED_AT,
    });
  });

  it("persists a lineage binding so the child is recorded without being narrowed", async () => {
    const created = await store.link({
      businessId: BUSINESS,
      parentRunId: PARENT_ID,
      childRunId: CHILD_ID,
      authority: { tools: [], classifications: [], limits: {} },
      authorityBinding: "lineage",
      createdAt: CREATED_AT,
    });

    expect(created.authorityBinding).toBe("lineage");
    expect(await ancestry.parentLink(BUSINESS, CHILD_ID)).toMatchObject({
      authorityBinding: "lineage",
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

  it("writes an already-detached link in one statement, leaving no open window", async () => {
    const stored = await store.link({
      businessId: BUSINESS,
      parentRunId: PARENT_ID,
      childRunId: CHILD_ID,
      authority: AUTHORITY,
      detachedAt: DETACHED_AT,
      createdAt: CREATED_AT,
    });

    // A child that never resumes its parent must not be reachable by a cancel cascade, not even
    // for the moment between an open insert and the update that closes it.
    expect(stored.detachedAt).toBe(DETACHED_AT);
    const links = await store.listChildren(BUSINESS, PARENT_ID);
    expect(links[0]?.detachedAt).toBe(DETACHED_AT);
  });

  it("treats detaching an already-detached link as a no-op rather than an error", async () => {
    await store.link({
      businessId: BUSINESS,
      parentRunId: PARENT_ID,
      childRunId: CHILD_ID,
      authority: AUTHORITY,
      detachedAt: DETACHED_AT,
      createdAt: CREATED_AT,
    });

    expect(await store.detach(BUSINESS, PARENT_ID, CHILD_ID, DETACHED_AT)).toBe(false);
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

  describe("listUnsignalledCompletions", () => {
    const WAIT_ID = "00000000-0000-4000-8000-0000000000aa";

    async function park(childRunId = CHILD_ID, waitId = WAIT_ID) {
      await waits.create({
        id: waitId,
        businessId: BUSINESS,
        runId: PARENT_ID,
        stateKey: "apply",
        kind: "event",
        aggregation: "first",
        schemaRef: "tulipfarm.run.child_completion.v1",
        allowedPrincipals: [`run:${childRunId}`],
        expectedSignals: 1,
        quorum: null,
        tokenHash: `hash-${childRunId}`,
        deadlineAt: "2026-07-25T12:00:00.000Z",
        createdAt: CREATED_AT,
      });
      await store.link({
        businessId: BUSINESS,
        parentRunId: PARENT_ID,
        childRunId,
        authority: AUTHORITY,
        resume: { waitId, token: "plaintext" },
        createdAt: CREATED_AT,
      });
    }

    async function settle(childRunId: string, status: string) {
      const child = await runs.find(BUSINESS, childRunId);
      if (child === null) throw new Error("missing child");
      await runs.transitionRun(BUSINESS, childRunId, {
        expectedVersion: child.version,
        expectedStatus: child.status,
        status: status as never,
        finishedAt: "2026-07-25T10:30:00.000Z",
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    }

    it.each([["succeeded"], ["failed"], ["cancelled"]])(
      "finds a %s child whose parent is still parked",
      async (status) => {
        await park();
        await settle(CHILD_ID, status);

        await expect(ancestry.listUnsignalledCompletions(BUSINESS, 10)).resolves.toEqual([
          { childRunId: CHILD_ID, status, finishedAt: "2026-07-25T10:30:00.000Z" },
        ]);
      }
    );

    it("ignores a child that has not finished", async () => {
      await park();

      await expect(ancestry.listUnsignalledCompletions(BUSINESS, 10)).resolves.toEqual([]);
    });

    it("ignores a completion whose signal already satisfied the wait", async () => {
      await park();
      await settle(CHILD_ID, "succeeded");
      await database.query(
        `UPDATE run_waits
            SET status = 'satisfied', resolved_at = now(), token_consumed_at = now()
          WHERE id = $1`,
        [WAIT_ID]
      );

      await expect(ancestry.listUnsignalledCompletions(BUSINESS, 10)).resolves.toEqual([]);
    });

    it("ignores a child the parent detached from", async () => {
      await park();
      await settle(CHILD_ID, "succeeded");
      await store.detach(BUSINESS, PARENT_ID, CHILD_ID, DETACHED_AT);

      await expect(ancestry.listUnsignalledCompletions(BUSINESS, 10)).resolves.toEqual([]);
    });

    it("ignores a fire-and-forget child, which granted no resume", async () => {
      await link();
      await settle(CHILD_ID, "succeeded");

      await expect(ancestry.listUnsignalledCompletions(BUSINESS, 10)).resolves.toEqual([]);
    });

    it("bounds the batch and returns the longest-waiting child first", async () => {
      await park(CHILD_ID, WAIT_ID);
      await park(OTHER_CHILD_ID, "00000000-0000-4000-8000-0000000000ab");
      await settle(OTHER_CHILD_ID, "succeeded");
      await database.query("UPDATE runs SET finished_at = $1 WHERE id = $2", [
        "2026-07-25T10:29:00.000Z",
        OTHER_CHILD_ID,
      ]);
      await settle(CHILD_ID, "failed");

      const found = await ancestry.listUnsignalledCompletions(BUSINESS, 1);

      expect(found.map((row) => row.childRunId)).toEqual([OTHER_CHILD_ID]);
    });
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
