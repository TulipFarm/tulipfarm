import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { Queryable } from "../db";
import { PG_MIGRATIONS } from "../pg-migrations";
import { makePglite } from "../test/pglite";
import { RoutineScheduleStateStore } from "./state-store";

let db: PGlite;
let queryable: Queryable;

async function migrate(version: number) {
  const migration = PG_MIGRATIONS.find((entry) => entry.version === version);
  if (!migration) throw new Error(`Missing migration ${version}`);
  await migration.up(queryable);
}

beforeEach(async () => {
  db = await makePglite();
  queryable = db as unknown as Queryable;
  await migrate(31);
  await migrate(79);
});

afterEach(async () => {
  await db.close();
});

test("migrates old checkpoints without losing either history during a reordered partial tick", async () => {
  await db.query(
    `INSERT INTO routine_schedule_state
       (business_id, routine_slug, trigger_index, dedup_key, last_scheduled_for_ms, next_due_at_ms, anchor_ms)
     VALUES ('business', 'digest', 0, 'first', 1000, 2000, 1000),
            ('business', 'digest', 1, 'second', 1500, 2500, 1500)`
  );
  await migrate(98);
  const store = new RoutineScheduleStateStore(queryable);
  const legacy = await store.listForBusiness("business");
  const first = legacy.find((row) => row.dedupKey === "first");
  const second = legacy.find((row) => row.dedupKey === "second");
  if (!first || !second) throw new Error("Migration lost a checkpoint");
  expect(first).toMatchObject({ triggerId: "legacy:0", anchorMs: 1000 });
  expect(second).toMatchObject({ triggerId: "legacy:1", anchorMs: 1500 });

  await store.upsert("business", { ...second, triggerId: "second-id", triggerIndex: 0 });
  const restarted = new RoutineScheduleStateStore(queryable);
  expect(await restarted.listForBusiness("business")).toEqual(expect.arrayContaining(legacy));
  await restarted.upsert("business", { ...first, triggerId: "first-id", triggerIndex: 1 });
  await restarted.pruneMissing(
    "business",
    [
      { routineSlug: "digest", triggerId: "first-id" },
      { routineSlug: "digest", triggerId: "second-id" },
    ],
    legacy
  );

  const persisted = await restarted.listForBusiness("business");
  expect(persisted).toHaveLength(2);
  expect(persisted).toEqual(
    expect.arrayContaining([
      { ...first, triggerId: "first-id", triggerIndex: 1 },
      { ...second, triggerId: "second-id", triggerIndex: 0 },
    ])
  );
  await migrate(98);
  expect(await restarted.listForBusiness("business")).toEqual(expect.arrayContaining(persisted));
});
