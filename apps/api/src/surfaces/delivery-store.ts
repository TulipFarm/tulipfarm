import type { SurfaceTarget } from "@tulipfarm/surface";

export type SurfaceDeliveryStatus = "pending" | "delivered" | "ambiguous" | "failed";

export interface SurfaceDeliveryKey {
  readonly artifactId: string;
  readonly revision: number;
  readonly target: SurfaceTarget;
  readonly destination: string;
}

export interface SurfaceDelivery extends SurfaceDeliveryKey {
  readonly providerMessageId: string | null;
  readonly status: SurfaceDeliveryStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly updatedAt: Date;
}

export interface SurfaceDeliveryReservation {
  readonly delivery: SurfaceDelivery;
  readonly shouldDispatch: boolean;
}

export interface SurfaceDeliveryStore {
  reserve(key: SurfaceDeliveryKey, now?: Date): Promise<SurfaceDeliveryReservation>;
  record(
    key: SurfaceDeliveryKey,
    result: {
      status: Exclude<SurfaceDeliveryStatus, "pending">;
      providerMessageId?: string;
      error?: string;
    },
    now?: Date
  ): Promise<SurfaceDelivery>;
  get(key: SurfaceDeliveryKey): Promise<SurfaceDelivery | null>;
}

function keyOf(key: SurfaceDeliveryKey): string {
  return [
    key.artifactId,
    key.revision,
    key.target.channel,
    key.target.surface,
    key.destination,
  ].join("\u0000");
}

export class MemorySurfaceDeliveryStore implements SurfaceDeliveryStore {
  private readonly deliveries = new Map<string, SurfaceDelivery>();

  async reserve(key: SurfaceDeliveryKey, now = new Date()): Promise<SurfaceDeliveryReservation> {
    const existing = this.deliveries.get(keyOf(key));
    if (existing?.status === "delivered" || existing?.status === "pending") {
      return { delivery: structuredClone(existing), shouldDispatch: false };
    }
    const delivery: SurfaceDelivery = {
      ...key,
      providerMessageId: existing?.providerMessageId ?? null,
      status: "pending",
      attempts: (existing?.attempts ?? 0) + 1,
      lastError: null,
      updatedAt: now,
    };
    this.deliveries.set(keyOf(key), delivery);
    return { delivery: structuredClone(delivery), shouldDispatch: true };
  }

  async record(
    key: SurfaceDeliveryKey,
    result: {
      status: Exclude<SurfaceDeliveryStatus, "pending">;
      providerMessageId?: string;
      error?: string;
    },
    now = new Date()
  ): Promise<SurfaceDelivery> {
    const existing = this.deliveries.get(keyOf(key));
    if (!existing) throw new Error("Surface delivery was not reserved.");
    const delivery: SurfaceDelivery = {
      ...existing,
      status: result.status,
      providerMessageId: result.providerMessageId ?? existing.providerMessageId,
      lastError: result.error ?? null,
      updatedAt: now,
    };
    this.deliveries.set(keyOf(key), delivery);
    return structuredClone(delivery);
  }

  async get(key: SurfaceDeliveryKey): Promise<SurfaceDelivery | null> {
    const delivery = this.deliveries.get(keyOf(key));
    return delivery ? structuredClone(delivery) : null;
  }
}
