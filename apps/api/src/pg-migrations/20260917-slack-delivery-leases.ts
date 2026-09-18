import { CHANNEL_RUN_DELIVERY_LEASE_STATEMENTS } from "@tulipfarm/storage";
import type { Queryable } from "../db";

export async function addSlackDeliveryLeases(q: Queryable): Promise<void> {
  for (const statement of CHANNEL_RUN_DELIVERY_LEASE_STATEMENTS) {
    await q.query(statement);
  }
}
