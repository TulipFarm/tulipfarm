import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "../ports";
import {
  CURATOR_WORK_STORAGE_STATEMENTS,
  type CuratorWorkRef,
  claimCuratorWork,
  completeCuratorWork,
  listUsersWithDueWork,
  oldestDueWorkAgeSeconds,
  recordCuratorWork,
  releaseCuratorWork,
} from "./work";

const BUSINESS = "business-1";
const JOB_1 = "11111111-1111-4111-8111-111111111111";
const JOB_2 = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("curator work claiming (PostgreSQL)", () => {
  let database: PGlite;
  let tx: Queryable;

  const at = (minutes: number): Date => new Date(Date.UTC(2026, 0, 1, 0, minutes));

  const record = async (ref: Partial<CuratorWorkRef> & { sourceKey: string }, minute: number) =>
    recordCuratorWork(
      tx,
      {
        businessId: ref.businessId ?? BUSINESS,
        userId: ref.userId ?? "user-1",
        reason: ref.reason ?? "turn_completed",
        sourceKey: ref.sourceKey,
      },
      at(minute)
    );

  const claim = (limit: number, userId = "user-1", jobId: string = JOB_1) =>
    claimCuratorWork(tx, { businessId: BUSINESS, userId, jobId, limit, now: at(99) });

  const statuses = async (): Promise<Record<string, string>> => {
    const rows = await tx.query<{ source_key: string; status: string; job_id: string | null }>(
      "SELECT source_key, status, job_id FROM curator_user_work ORDER BY source_key"
    );
    return Object.fromEntries(rows.rows.map((row) => [row.source_key, row.status]));
  };

  beforeAll(async () => {
    database = new PGlite();
    tx = database as unknown as Queryable;
    for (const statement of CURATOR_WORK_STORAGE_STATEMENTS) await database.exec(statement);
  });

  afterAll(async () => await database.close());

  beforeEach(async () => await database.exec("TRUNCATE curator_user_work"));

  it("records the same source once, so a retried Turn completion cannot duplicate work", async () => {
    await record({ sourceKey: "turn-1" }, 0);
    await record({ sourceKey: "turn-1" }, 5);
    expect(await claim(10)).toHaveLength(1);
  });

  it("keeps two reasons for one source distinct", async () => {
    await record({ sourceKey: "turn-1", reason: "turn_completed" }, 0);
    await record({ sourceKey: "turn-1", reason: "proposal_resolved" }, 0);
    expect(await claim(10)).toHaveLength(2);
  });

  it("claims the oldest backlog first, so no user is starved", async () => {
    await record({ sourceKey: "newest" }, 30);
    await record({ sourceKey: "oldest" }, 0);
    await record({ sourceKey: "middle" }, 15);
    const claimed = await claim(2);
    expect(claimed.map((ref) => ref.sourceKey).sort()).toEqual(["middle", "oldest"]);
    expect((await statuses()).newest).toBe("due");
  });

  it("leaves work beyond the cap due rather than overflowing one Run", async () => {
    for (let index = 0; index < 5; index += 1) await record({ sourceKey: `turn-${index}` }, index);
    await claim(2);
    const after = await statuses();
    expect(Object.values(after).filter((status) => status === "due")).toHaveLength(3);
  });

  it("returns the claim in a stable order, so the manifest digest is deterministic", async () => {
    await record({ sourceKey: "b" }, 0);
    await record({ sourceKey: "a" }, 0);
    await record({ sourceKey: "c", reason: "daily_refresh_due" }, 0);
    const claimed = await claim(10);
    expect(claimed.map((ref) => `${ref.reason}:${ref.sourceKey}`)).toEqual([
      "daily_refresh_due:c",
      "turn_completed:a",
      "turn_completed:b",
    ]);
  });

  it("never claims another user's work", async () => {
    await record({ sourceKey: "mine" }, 0);
    await record({ sourceKey: "theirs", userId: "user-2" }, 0);
    expect((await claim(10)).map((ref) => ref.sourceKey)).toEqual(["mine"]);
  });

  it("never claims work already bound to another job", async () => {
    await record({ sourceKey: "turn-1" }, 0);
    await claim(10, "user-1", JOB_1);
    expect(await claim(10, "user-1", JOB_2)).toEqual([]);
  });

  it("returns abandoned work to due, so an admission refusal loses nothing", async () => {
    await record({ sourceKey: "turn-1" }, 0);
    await claim(10);
    expect(await releaseCuratorWork(tx, JOB_1)).toBe(1);
    expect((await statuses())["turn-1"]).toBe("due");
    expect(await claim(10, "user-1", JOB_2)).toHaveLength(1);
  });

  it("releases only the named job's claims", async () => {
    await record({ sourceKey: "turn-1" }, 0);
    await record({ sourceKey: "turn-2", userId: "user-2" }, 0);
    await claim(10, "user-1", JOB_1);
    await claim(10, "user-2", JOB_2);
    await releaseCuratorWork(tx, JOB_1);
    expect(await statuses()).toEqual({ "turn-1": "due", "turn-2": "claimed" });
  });

  it("retires claimed work once its job settled, and never re-serves it", async () => {
    await record({ sourceKey: "turn-1" }, 0);
    await claim(10);
    expect(await completeCuratorWork(tx, JOB_1, at(50))).toBe(1);
    expect((await statuses())["turn-1"]).toBe("done");
    expect(await claim(10, "user-1", JOB_2)).toEqual([]);
  });

  it("cannot release work a completed job already retired", async () => {
    await record({ sourceKey: "turn-1" }, 0);
    await claim(10);
    await completeCuratorWork(tx, JOB_1, at(50));
    expect(await releaseCuratorWork(tx, JOB_1)).toBe(0);
  });
});

describe("curator sweep fan-out (PostgreSQL)", () => {
  let database: PGlite;
  let tx: Queryable;

  const at = (minutes: number): Date => new Date(Date.UTC(2026, 0, 1, 0, minutes));

  const user = async (id: string, status: string) =>
    await database.query("INSERT INTO users (id, status) VALUES ($1, $2)", [id, status]);

  const work = async (userId: string, sourceKey: string, minute: number) =>
    await recordCuratorWork(
      tx,
      { businessId: BUSINESS, userId, reason: "turn_completed", sourceKey },
      at(minute)
    );

  const due = (limit = 10) => listUsersWithDueWork(tx, { businessId: BUSINESS, limit });

  beforeAll(async () => {
    database = new PGlite();
    tx = database as unknown as Queryable;
    for (const statement of CURATOR_WORK_STORAGE_STATEMENTS) await database.exec(statement);
    await database.exec("CREATE TABLE users (id uuid PRIMARY KEY, status text NOT NULL)");
  });

  afterAll(async () => await database.close());

  beforeEach(async () => await database.exec("TRUNCATE curator_user_work, users"));

  // The mint counters say the sweep ran; only this says whether it is keeping up.
  it("measures staleness from the oldest unserved row, not the newest", async () => {
    await user(USER_A, "active");
    await work(USER_A, "ancient", 0);
    await work(USER_A, "recent", 30);

    const age = await oldestDueWorkAgeSeconds(tx, BUSINESS);

    const expected = (Date.now() - at(0).getTime()) / 1000;
    expect(age).toBeGreaterThan(expected - 60);
  });

  it("reports no age at all when nothing is waiting", async () => {
    expect(await oldestDueWorkAgeSeconds(tx, BUSINESS)).toBeNull();
  });

  // Claimed work is being served right now, so counting it as backlog would make a healthy loop
  // look permanently behind.
  it("ignores work a job has already claimed", async () => {
    await user(USER_A, "active");
    await work(USER_A, "ancient", 0);
    await tx.query("UPDATE curator_user_work SET status = 'claimed'");

    expect(await oldestDueWorkAgeSeconds(tx, BUSINESS)).toBeNull();
  });

  it("ignores another business's backlog", async () => {
    await user(USER_A, "active");
    await work(USER_A, "ancient", 0);

    expect(await oldestDueWorkAgeSeconds(tx, "other-business")).toBeNull();
  });

  it("serves the oldest backlog first, so a busy user cannot starve a quiet one", async () => {
    await user(USER_A, "active");
    await user(USER_B, "active");
    await work(USER_B, "recent", 30);
    await work(USER_A, "ancient", 0);
    await work(USER_B, "newer", 40);

    expect(await due()).toEqual([USER_A, USER_B]);
  });

  // Model budget spent on someone who cannot read the result is budget the loop stole from someone
  // who can.
  it("skips users who are not active", async () => {
    await user(USER_A, "disabled");
    await user(USER_B, "invited");
    await work(USER_A, "turn-1", 0);
    await work(USER_B, "turn-2", 1);

    expect(await due()).toEqual([]);
  });

  it("names each user once however deep their backlog", async () => {
    await user(USER_A, "active");
    await work(USER_A, "turn-1", 0);
    await work(USER_A, "turn-2", 1);
    await work(USER_A, "turn-3", 2);

    expect(await due()).toEqual([USER_A]);
  });

  it("ignores work already claimed by a live job", async () => {
    await user(USER_A, "active");
    await work(USER_A, "turn-1", 0);
    await claimCuratorWork(tx, {
      businessId: BUSINESS,
      userId: USER_A,
      jobId: JOB_1,
      limit: 10,
      now: at(5),
    });

    expect(await due()).toEqual([]);
  });

  it("caps the fan-out, leaving the rest for the next sweep", async () => {
    await user(USER_A, "active");
    await user(USER_B, "active");
    await work(USER_A, "turn-1", 0);
    await work(USER_B, "turn-2", 1);

    expect(await due(1)).toEqual([USER_A]);
  });

  it("does not cross businesses", async () => {
    await user(USER_A, "active");
    await recordCuratorWork(
      tx,
      { businessId: "other", userId: USER_A, reason: "turn_completed", sourceKey: "turn-1" },
      at(0)
    );

    expect(await due()).toEqual([]);
  });
});
