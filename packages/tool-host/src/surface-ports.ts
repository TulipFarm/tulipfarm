import type { TSchema } from "@sinclair/typebox";
import type {
  SurfaceAction,
  SurfaceArtifact,
  SurfaceComponentDefinition,
  SurfaceInteraction,
  SurfaceRendererManifest,
  SurfaceTarget,
} from "@tulipfarm/surface";

/**
 * Persistence contracts for Surface Artifacts and their action handles. They live here, not with
 * their PostgreSQL implementations, because a Tool's `RequestContext` names them: the contract has
 * to be reachable from every process that can execute a Tool, while the implementation stays with
 * whichever process owns the database wiring.
 */

export interface SurfaceArtifactStore {
  create(
    artifact: SurfaceArtifact,
    producer?: { runId?: string; stateKey?: string }
  ): Promise<void>;
  get(artifactId: string, revision?: number): Promise<SurfaceArtifact | null>;
  /** The latest Artifact `present`/`update_presentation` produced for a given Run, if any. */
  findByRun(runId: string): Promise<SurfaceArtifact | null>;
  update(
    artifactId: string,
    expectedRevision: number,
    props: Readonly<Record<string, unknown>>,
    catalog?: readonly SurfaceComponentDefinition[],
    rendererManifest?: SurfaceRendererManifest,
    producer?: { runId?: string; stateKey?: string }
  ): Promise<SurfaceArtifact>;
}

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
