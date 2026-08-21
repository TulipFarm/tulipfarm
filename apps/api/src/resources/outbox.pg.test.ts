import { EventEmitter } from "node:events";
import type { PGlite } from "@electric-sql/pglite";
import { DOMAIN_EVENTS, type ResourceEventPayload } from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import {
  deliverResourceSideEffect,
  type ResourceSideEffect,
  ResourceSideEffectDispatcher,
  ResourceSideEffectOutbox,
  writeResourceSideEffect,
} from "./outbox";

describe("resource side-effect outbox", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await makeMigratedPglite();
  });

  afterEach(async () => {
    await db.close();
  });

  it("replays a failed delivery without losing the committed Record mutation", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const effect: ResourceSideEffect = {
      kind: "create",
      resourceType: "ticket",
      resourceId: "22222222-2222-4222-8222-222222222222",
      record: { id: "22222222-2222-4222-8222-222222222222", title: "Retry me" },
    };
    await writeResourceSideEffect(db, id, effect);

    const emitted: string[] = [];
    const events = new EventEmitter();
    events.on(DOMAIN_EVENTS.RESOURCE_CREATED, (payload: ResourceEventPayload) =>
      emitted.push(payload.resourceId)
    );
    let failOnce = true;
    const dispatcher = new ResourceSideEffectDispatcher(
      new ResourceSideEffectOutbox(db),
      "test-resource-side-effects",
      async (pending) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("transient hook outage");
        }
        await deliverResourceSideEffect(pending, undefined, events);
      }
    );

    await dispatcher.dispatchBatch();
    const pending = await db.query(
      `SELECT status, attempts FROM resource_side_effect_outbox WHERE id = $1`,
      [id]
    );
    expect(pending.rows[0]).toMatchObject({ status: "pending", attempts: 1 });
    expect(emitted).toEqual([]);

    await dispatcher.dispatchBatch();
    const delivered = await db.query(
      `SELECT status, attempts, delivered_at FROM resource_side_effect_outbox WHERE id = $1`,
      [id]
    );
    expect(delivered.rows[0]).toMatchObject({ status: "delivered", attempts: 2 });
    expect((delivered.rows[0] as { delivered_at: Date | null }).delivered_at).not.toBeNull();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toBe(effect.resourceId);
  });
});
