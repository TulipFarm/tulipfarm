import type { SurfaceTarget } from "@tulipfarm/surface";
import type { Queryable } from "../db";

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

export class PgSurfaceDeliveryStore implements SurfaceDeliveryStore {
  constructor(private readonly q: Queryable) {}

  async reserve(key: SurfaceDeliveryKey, now = new Date()): Promise<SurfaceDeliveryReservation> {
    const existing = await this.get(key);
    if (existing?.status === "delivered" || existing?.status === "pending") {
      return { delivery: existing, shouldDispatch: false };
    }
    const { rows } = await this.q.query(
      `INSERT INTO surface_deliveries (
         artifact_id, revision, channel, surface, destination, provider_message_id,
         status, attempts, last_error, updated_at
       ) VALUES ($1, $2, $3, $4, $5, NULL, 'pending', 1, NULL, $6)
       ON CONFLICT (artifact_id, revision, channel, surface, destination)
       DO UPDATE SET
         status = 'pending',
         attempts = surface_deliveries.attempts + 1,
         last_error = NULL,
         updated_at = EXCLUDED.updated_at
       WHERE surface_deliveries.status IN ('failed', 'ambiguous')
       RETURNING *`,
      [key.artifactId, key.revision, key.target.channel, key.target.surface, key.destination, now]
    );
    if (rows[0]) return { delivery: fromRow(rows[0]), shouldDispatch: true };
    const concurrent = await this.get(key);
    if (!concurrent) throw new Error("Surface delivery reservation failed.");
    return { delivery: concurrent, shouldDispatch: false };
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
    const { rows } = await this.q.query(
      `UPDATE surface_deliveries
          SET status = $6,
              provider_message_id = COALESCE($7, provider_message_id),
              last_error = $8,
              updated_at = $9
        WHERE artifact_id = $1
          AND revision = $2
          AND channel = $3
          AND surface = $4
          AND destination = $5
        RETURNING *`,
      [
        key.artifactId,
        key.revision,
        key.target.channel,
        key.target.surface,
        key.destination,
        result.status,
        result.providerMessageId ?? null,
        result.error ?? null,
        now,
      ]
    );
    if (!rows[0]) throw new Error("Surface delivery was not reserved.");
    return fromRow(rows[0]);
  }

  async get(key: SurfaceDeliveryKey): Promise<SurfaceDelivery | null> {
    const { rows } = await this.q.query(
      `SELECT *
         FROM surface_deliveries
        WHERE artifact_id = $1
          AND revision = $2
          AND channel = $3
          AND surface = $4
          AND destination = $5`,
      [key.artifactId, key.revision, key.target.channel, key.target.surface, key.destination]
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }
}

function fromRow(row: Record<string, unknown>): SurfaceDelivery {
  return {
    artifactId: String(row.artifact_id),
    revision: Number(row.revision),
    target: {
      channel: String(row.channel),
      surface: String(row.surface),
    } as SurfaceTarget,
    destination: String(row.destination),
    providerMessageId: typeof row.provider_message_id === "string" ? row.provider_message_id : null,
    status: String(row.status) as SurfaceDeliveryStatus,
    attempts: Number(row.attempts),
    lastError: typeof row.last_error === "string" ? row.last_error : null,
    updatedAt: new Date(row.updated_at as string | Date),
  };
}
