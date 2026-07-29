import { randomBytes, randomUUID } from "node:crypto";
import type { TSchema } from "@sinclair/typebox";
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
}

function opaqueHandle(): string {
  return `sf_${randomBytes(18).toString("base64url")}`;
}

function interaction(
  handle: SurfaceActionHandle,
  principal: string,
  input: Readonly<Record<string, unknown>>,
  now: Date
): SurfaceInteraction {
  return {
    id: randomUUID(),
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
    const now = input.now ?? new Date();
    const found = this.handles.get(input.handle) ?? null;
    const result = validateResolution(found, { ...input, now });
    if (!result) throw new Error("Unreachable Surface action resolution.");
    if (result.ok) {
      this.handles.set(input.handle, { ...result.handle, consumedAt: now });
    }
    return result;
  }
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
    const source = rows[0];
    const found: SurfaceActionHandle | null = source
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
          conversationId:
            typeof source.conversation_id === "string" ? source.conversation_id : null,
          runId: typeof source.run_id === "string" ? source.run_id : null,
          waitId: typeof source.wait_id === "string" ? source.wait_id : null,
          guardrailRevision: String(source.guardrail_revision),
          expiresAt: new Date(source.expires_at as string | Date),
          consumedAt: source.consumed_at ? new Date(source.consumed_at as string | Date) : null,
          stepUp: source.step_up === true,
        }
      : null;
    const result = validateResolution(found, { ...input, now });
    if (!result) throw new Error("Unreachable Surface action resolution.");
    if (!result.ok) return result;
    const consumed = await this.q.query(
      `UPDATE surface_actions
          SET consumed_at = $2
        WHERE handle = $1 AND consumed_at IS NULL
        RETURNING handle`,
      [input.handle, now]
    );
    if (consumed.rows.length !== 1) return { ok: false, code: "replayed" };
    return result;
  }
}
