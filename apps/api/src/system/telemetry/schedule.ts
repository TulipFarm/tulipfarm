import { PRODUCT_TELEMETRY_QUEUE, productTelemetryPolicy } from "@tulipfarm/observability";
import type { PgBoss } from "pg-boss";

export async function scheduleProductTelemetry(boss: PgBoss): Promise<void> {
  if (!productTelemetryPolicy(process.env).enabled) return;
  await boss.createQueue(PRODUCT_TELEMETRY_QUEUE);
  await boss.schedule(PRODUCT_TELEMETRY_QUEUE, "*/5 * * * *");
  await boss.send(PRODUCT_TELEMETRY_QUEUE, {}, { singletonKey: "boot", singletonSeconds: 60 });
}
