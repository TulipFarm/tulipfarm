import { randomBytes, randomUUID } from "node:crypto";
import type { TSchema } from "@sinclair/typebox";
import { canonicalHash } from "@tulipfarm/schema";
import {
  type SurfaceAction,
  type SurfaceInteraction,
  type SurfaceTarget,
  surfaceActionKey,
  surfaceSchemaIssues,
} from "@tulipfarm/surface";
import type { Queryable } from "../db";

export interface SurfaceActionHandle {
  readonly handle: string;
  readonly artifactId: string;
  readonly revision: number;
  readonly event: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly inputSchema: TSchema;
  readonly audience: readonly string[];
  readonly target: SurfaceTarget;
  readonly destination: string;
  readonly conversationId: string | null;
  readonly runId: string | null;
  readonly waitId: string | null;
  readonly guardrailRevision: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly stepUp: boolean;
}

export interface CreateSurfaceActionHandleInput
  extends Omit<SurfaceActionHandle, "handle" | "consumedAt" | "event" | "payload" | "stepUp"> {
  readonly action: SurfaceAction;
}

export type SurfaceActionResolution =
  | {
      readonly ok: true;
      readonly handle: SurfaceActionHandle;
      readonly interaction: SurfaceInteraction;
    }
  | {
      readonly ok: false;
      readonly code:
        | "expired"
        | "guardrail_changed"
        | "invalid_input"
        | "not_found"
        | "replayed"
        | "step_up_required"
        | "wrong_principal";
    };

export type SurfaceActionReservation =
  | {
      readonly ok: true;
      readonly outcome: "reserved" | "existing" | "completed";
      readonly handle: SurfaceActionHandle;
      readonly interaction: SurfaceInteraction;
    }
  | Extract<SurfaceActionResolution, { readonly ok: false }>;

export interface ReserveSurfaceActionInput {
  readonly handle: string;
  readonly principal: string;
  readonly principalKind: string;
  readonly value: unknown;
  readonly currentGuardrailRevision: string;
  readonly stepUpSatisfied: boolean;
  readonly now?: Date;
}

export interface PendingSurfaceAction {
  readonly handle: SurfaceActionHandle;
  readonly interactionId: string;
  readonly principal: string;
  readonly principalKind: string;
  readonly reservedAt: Date;
}

export interface SurfaceActionStore {
  create(input: CreateSurfaceActionHandleInput): Promise<SurfaceActionHandle>;
  listForArtifact(
    artifactId: string,
    revision: number,
    principal: string
  ): Promise<Readonly<Record<string, string>>>;
  resolve(input: {
    handle: string;
    principal: string;
    value: unknown;
    currentGuardrailRevision: string;
    stepUpSatisfied: boolean;
    now?: Date;
  }): Promise<SurfaceActionResolution>;
  reserve(input: ReserveSurfaceActionInput): Promise<SurfaceActionReservation>;
  findReservation(interactionId: string): Promise<PendingSurfaceAction | undefined>;
  listPending(before: Date, limit: number): Promise<readonly PendingSurfaceAction[]>;
  complete(input: {
    handle: string;
    interactionId: string;
    now?: Date;
  }): Promise<"consumed" | "replayed">;
}

function opaqueHandle(): string {
  return `sf_${randomBytes(18).toString("base64url")}`;
}

function interaction(
  handle: SurfaceActionHandle,
  principal: string,
  input: Readonly<Record<string, unknown>>,
  now: Date,
  id: string = randomUUID()
): SurfaceInteraction {
  return {
    id,
    artifactId: handle.artifactId,
    revision: handle.revision,
    event: handle.event,
    input: { ...handle.payload, ...input },
    principal,
    target: handle.target,
    destination: handle.destination,
    occurredAt: now.toISOString(),
  };
}

interface SurfaceActionReservationState {
  readonly interactionId: string;
  readonly principal: string;
  readonly principalKind: string;
  readonly inputHash: string;
  readonly reservedAt: Date;
}

function interactionInput(
  handle: SurfaceActionHandle,
  value: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  return { ...handle.payload, ...value };
}

function reservedInteraction(
  handle: SurfaceActionHandle,
  reservation: SurfaceActionReservationState,
  value: Readonly<Record<string, unknown>>
): SurfaceInteraction {
  return interaction(
    handle,
    reservation.principal,
    value,
    reservation.reservedAt,
    reservation.interactionId
  );
}

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function validateResolution(
  handle: SurfaceActionHandle | null,
  input: {
    principal: string;
    value: unknown;
    currentGuardrailRevision: string;
    stepUpSatisfied: boolean;
    now: Date;
  }
): SurfaceActionResolution | null {
  if (!handle) return { ok: false, code: "not_found" };
  if (handle.consumedAt) return { ok: false, code: "replayed" };
  if (input.now >= handle.expiresAt) return { ok: false, code: "expired" };
  if (!handle.audience.includes(input.principal)) return { ok: false, code: "wrong_principal" };
  if (handle.guardrailRevision !== input.currentGuardrailRevision) {
    return { ok: false, code: "guardrail_changed" };
  }
  if (handle.stepUp && !input.stepUpSatisfied) return { ok: false, code: "step_up_required" };
  const value = object(input.value);
  if (!value || surfaceSchemaIssues(handle.inputSchema, value).length > 0) {
    return { ok: false, code: "invalid_input" };
  }
  return {
    ok: true,
    handle,
    interaction: interaction(handle, input.principal, value, input.now),
  };
}

export class MemorySurfaceActionStore implements SurfaceActionStore {
  private readonly handles = new Map<string, SurfaceActionHandle>();
  private readonly reservations = new Map<string, SurfaceActionReservationState>();

  async create(input: CreateSurfaceActionHandleInput): Promise<SurfaceActionHandle> {
    const handle: SurfaceActionHandle = {
      ...input,
      handle: opaqueHandle(),
      event: input.action.event,
      payload: input.action.payload ?? {},
      stepUp: input.action.stepUp ?? false,
      consumedAt: null,
    };
    this.handles.set(handle.handle, handle);
    return handle;
  }

  async listForArtifact(
    artifactId: string,
    revision: number,
    principal: string
  ): Promise<Readonly<Record<string, string>>> {
    const now = new Date();
    return Object.fromEntries(
      [...this.handles.values()]
        .filter(
          (handle) =>
            handle.artifactId === artifactId &&
            handle.revision === revision &&
            handle.audience.includes(principal) &&
            handle.consumedAt === null &&
            !this.reservations.has(handle.handle) &&
            handle.expiresAt > now
        )
        .map((handle) => [
          surfaceActionKey({
            event: handle.event,
            payload: handle.payload,
            stepUp: handle.stepUp,
          }),
          handle.handle,
        ])
    );
  }

  async resolve(input: {
    handle: string;
    principal: string;
    value: unknown;
    currentGuardrailRevision: string;
    stepUpSatisfied: boolean;
    now?: Date;
  }): Promise<SurfaceActionResolution> {
    if (this.reservations.has(input.handle)) return { ok: false, code: "replayed" };
    const now = input.now ?? new Date();
    const found = this.handles.get(input.handle) ?? null;
    const result = validateResolution(found, { ...input, now });
    if (!result) throw new Error("Unreachable Surface action resolution.");
    if (result.ok) {
      this.handles.set(input.handle, { ...result.handle, consumedAt: now });
    }
    return result;
  }

  async reserve(input: ReserveSurfaceActionInput): Promise<SurfaceActionReservation> {
    const now = input.now ?? new Date();
    const found = this.handles.get(input.handle) ?? null;
    const value = object(input.value);
    const existing = this.reservations.get(input.handle);
    if (existing !== undefined) {
      if (found === null) return { ok: false, code: "not_found" };
      if (
        value === null ||
        existing.principal !== input.principal ||
        existing.principalKind !== input.principalKind ||
        existing.inputHash !== canonicalHash(interactionInput(found, value))
      ) {
        return { ok: false, code: "replayed" };
      }
      return {
        ok: true,
        outcome: found.consumedAt === null ? "existing" : "completed",
        handle: found,
        interaction: reservedInteraction(found, existing, value),
      };
    }

    const result = validateResolution(found, { ...input, now });
    if (!result) throw new Error("Unreachable Surface action reservation.");
    if (!result.ok) return result;
    const reservation: SurfaceActionReservationState = {
      interactionId: result.interaction.id,
      principal: input.principal,
      principalKind: input.principalKind,
      inputHash: canonicalHash(result.interaction.input),
      reservedAt: now,
    };
    this.reservations.set(input.handle, reservation);
    return { ...result, outcome: "reserved" };
  }

  async findReservation(interactionId: string): Promise<PendingSurfaceAction | undefined> {
    for (const [handleId, reservation] of this.reservations) {
      if (reservation.interactionId !== interactionId) continue;
      const handle = this.handles.get(handleId);
      if (handle === undefined) return undefined;
      return { handle, ...reservation };
    }
    return undefined;
  }

  async listPending(before: Date, limit: number): Promise<readonly PendingSurfaceAction[]> {
    const pending: PendingSurfaceAction[] = [];
    for (const [handleId, reservation] of this.reservations) {
      const handle = this.handles.get(handleId);
      if (handle !== undefined && handle.consumedAt === null && reservation.reservedAt <= before) {
        pending.push({ handle, ...reservation });
      }
    }
    return pending
      .sort((left, right) => left.reservedAt.getTime() - right.reservedAt.getTime())
      .slice(0, limit);
  }

  async complete(input: {
    handle: string;
    interactionId: string;
    now?: Date;
  }): Promise<"consumed" | "replayed"> {
    const found = this.handles.get(input.handle);
    const reservation = this.reservations.get(input.handle);
    if (
      found === undefined ||
      reservation === undefined ||
      reservation.interactionId !== input.interactionId
    ) {
      throw new Error("surface_action_reservation_missing");
    }
    if (found.consumedAt !== null) return "replayed";
    this.handles.set(input.handle, { ...found, consumedAt: input.now ?? new Date() });
    return "consumed";
  }
}

function handleFromRow(source: Record<string, unknown> | undefined): SurfaceActionHandle | null {
  return source
    ? {
        handle: String(source.handle),
        artifactId: String(source.artifact_id),
        revision: Number(source.revision),
        event: String(source.event),
        payload: source.payload as Record<string, unknown>,
        inputSchema: source.input_schema as TSchema,
        audience: source.audience as string[],
        target: source.target as SurfaceTarget,
        destination: String(source.destination),
        conversationId: typeof source.conversation_id === "string" ? source.conversation_id : null,
        runId: typeof source.run_id === "string" ? source.run_id : null,
        waitId: typeof source.wait_id === "string" ? source.wait_id : null,
        guardrailRevision: String(source.guardrail_revision),
        expiresAt: new Date(source.expires_at as string | Date),
        consumedAt: source.consumed_at ? new Date(source.consumed_at as string | Date) : null,
        stepUp: source.step_up === true,
      }
    : null;
}

function reservationFromRow(
  source: Record<string, unknown> | undefined
): SurfaceActionReservationState | undefined {
  if (
    source === undefined ||
    typeof source.reserved_interaction_id !== "string" ||
    typeof source.reserved_principal_id !== "string" ||
    typeof source.reserved_principal_kind !== "string" ||
    typeof source.reserved_input_hash !== "string" ||
    source.reserved_at === null ||
    source.reserved_at === undefined
  ) {
    return undefined;
  }
  return {
    interactionId: source.reserved_interaction_id,
    principal: source.reserved_principal_id,
    principalKind: source.reserved_principal_kind,
    inputHash: source.reserved_input_hash,
    reservedAt: new Date(source.reserved_at as string | Date),
  };
}

export class PgSurfaceActionStore implements SurfaceActionStore {
  constructor(private readonly q: Queryable) {}

  async create(input: CreateSurfaceActionHandleInput): Promise<SurfaceActionHandle> {
    const row: SurfaceActionHandle = {
      ...input,
      handle: opaqueHandle(),
      event: input.action.event,
      payload: input.action.payload ?? {},
      stepUp: input.action.stepUp ?? false,
      consumedAt: null,
    };
    await this.q.query(
      `INSERT INTO surface_actions (
         handle, artifact_id, revision, event, payload, input_schema, audience, target,
         destination, conversation_id, run_id, wait_id, guardrail_revision, expires_at,
         consumed_at, step_up
       ) VALUES (
         $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::text[], $8::jsonb,
         $9, $10, $11, $12, $13, $14, NULL, $15
       )`,
      [
        row.handle,
        row.artifactId,
        row.revision,
        row.event,
        JSON.stringify(row.payload),
        JSON.stringify(row.inputSchema),
        row.audience,
        JSON.stringify(row.target),
        row.destination,
        row.conversationId,
        row.runId,
        row.waitId,
        row.guardrailRevision,
        row.expiresAt,
        row.stepUp,
      ]
    );
    return row;
  }

  async listForArtifact(
    artifactId: string,
    revision: number,
    principal: string
  ): Promise<Readonly<Record<string, string>>> {
    const { rows } = await this.q.query(
      `SELECT handle, event, payload, step_up
         FROM surface_actions
        WHERE artifact_id = $1
          AND revision = $2
          AND $3 = ANY(audience)
          AND consumed_at IS NULL
          AND reserved_interaction_id IS NULL
          AND expires_at > NOW()`,
      [artifactId, revision, principal]
    );
    return Object.fromEntries(
      rows.map((row) => [
        surfaceActionKey({
          event: String(row.event),
          payload: row.payload as Record<string, unknown>,
          stepUp: row.step_up === true,
        }),
        String(row.handle),
      ])
    );
  }

  async resolve(input: {
    handle: string;
    principal: string;
    value: unknown;
    currentGuardrailRevision: string;
    stepUpSatisfied: boolean;
    now?: Date;
  }): Promise<SurfaceActionResolution> {
    const now = input.now ?? new Date();
    const { rows } = await this.q.query("SELECT * FROM surface_actions WHERE handle = $1", [
      input.handle,
    ]);
    if (reservationFromRow(rows[0]) !== undefined) return { ok: false, code: "replayed" };
    const found = handleFromRow(rows[0]);
    const result = validateResolution(found, { ...input, now });
    if (!result) throw new Error("Unreachable Surface action resolution.");
    if (!result.ok) return result;
    const consumed = await this.q.query(
      `UPDATE surface_actions
          SET consumed_at = $2
        WHERE handle = $1
          AND consumed_at IS NULL
          AND reserved_interaction_id IS NULL
        RETURNING handle`,
      [input.handle, now]
    );
    if (consumed.rows.length !== 1) return { ok: false, code: "replayed" };
    return result;
  }

  async reserve(input: ReserveSurfaceActionInput): Promise<SurfaceActionReservation> {
    const now = input.now ?? new Date();
    const { rows } = await this.q.query("SELECT * FROM surface_actions WHERE handle = $1", [
      input.handle,
    ]);
    const found = handleFromRow(rows[0]);
    const value = object(input.value);
    const existing = reservationFromRow(rows[0]);
    if (typeof rows[0]?.reserved_interaction_id === "string" && existing === undefined) {
      return { ok: false, code: "replayed" };
    }
    if (existing !== undefined) {
      if (found === null) return { ok: false, code: "not_found" };
      if (
        value === null ||
        existing.principal !== input.principal ||
        existing.principalKind !== input.principalKind ||
        existing.inputHash !== canonicalHash(interactionInput(found, value))
      ) {
        return { ok: false, code: "replayed" };
      }
      return {
        ok: true,
        outcome: found.consumedAt === null ? "existing" : "completed",
        handle: found,
        interaction: reservedInteraction(found, existing, value),
      };
    }

    const result = validateResolution(found, { ...input, now });
    if (!result) throw new Error("Unreachable Surface action reservation.");
    if (!result.ok) return result;
    const inputHash = canonicalHash(result.interaction.input);
    const reserved = await this.q.query(
      `UPDATE surface_actions
          SET reserved_interaction_id = $2,
              reserved_principal_id = $3,
              reserved_principal_kind = $4,
              reserved_input_hash = $5,
              reserved_at = $6
        WHERE handle = $1
          AND consumed_at IS NULL
          AND reserved_interaction_id IS NULL
        RETURNING handle`,
      [input.handle, result.interaction.id, input.principal, input.principalKind, inputHash, now]
    );
    if (reserved.rows.length === 1) return { ...result, outcome: "reserved" };
    return this.reserve(input);
  }

  async findReservation(interactionId: string): Promise<PendingSurfaceAction | undefined> {
    const { rows } = await this.q.query(
      "SELECT * FROM surface_actions WHERE reserved_interaction_id = $1",
      [interactionId]
    );
    const handle = handleFromRow(rows[0]);
    const reservation = reservationFromRow(rows[0]);
    return handle === null || reservation === undefined ? undefined : { handle, ...reservation };
  }

  async listPending(before: Date, limit: number): Promise<readonly PendingSurfaceAction[]> {
    const { rows } = await this.q.query(
      `SELECT *
         FROM surface_actions
        WHERE reserved_interaction_id IS NOT NULL
          AND consumed_at IS NULL
          AND reserved_at <= $1
        ORDER BY reserved_at, handle
        LIMIT $2`,
      [before, limit]
    );
    return rows.flatMap((row) => {
      const handle = handleFromRow(row);
      const reservation = reservationFromRow(row);
      return handle === null || reservation === undefined ? [] : [{ handle, ...reservation }];
    });
  }

  async complete(input: {
    handle: string;
    interactionId: string;
    now?: Date;
  }): Promise<"consumed" | "replayed"> {
    const consumed = await this.q.query(
      `UPDATE surface_actions
          SET consumed_at = $3
        WHERE handle = $1
          AND reserved_interaction_id = $2
          AND consumed_at IS NULL
        RETURNING handle`,
      [input.handle, input.interactionId, input.now ?? new Date()]
    );
    if (consumed.rows.length === 1) return "consumed";
    const { rows } = await this.q.query(
      `SELECT reserved_interaction_id, consumed_at
         FROM surface_actions
        WHERE handle = $1`,
      [input.handle]
    );
    const row = rows[0];
    if (row?.reserved_interaction_id === input.interactionId && row.consumed_at !== null) {
      return "replayed";
    }
    throw new Error("surface_action_reservation_missing");
  }
}
