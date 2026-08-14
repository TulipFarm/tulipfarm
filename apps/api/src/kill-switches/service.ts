import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type {
  KillSwitchAuditEvidence,
  KillSwitchAuditPort,
  KillSwitchScopeKind,
} from "@tulipfarm/observability";
import type { EnableKillSwitchInput, KillSwitchRecord } from "@tulipfarm/storage";
import { KillSwitchStoreError } from "@tulipfarm/storage";
import type { AuditService } from "../audit/service";

/**
 * The audit slice this service uses. Named apart from `KillSwitchAuditPort`, which is the guard's
 * denial hook; this one records operator actions on the switch itself.
 */
export type AuditRecorder = Pick<AuditService, "recordOrWarn">;

/** The slice of `KillSwitchRepo` this service needs; keeps the admin surface storage-agnostic. */
export interface KillSwitchStorePort {
  list(businessId: string): Promise<readonly KillSwitchRecord[]>;
  enable(input: EnableKillSwitchInput): Promise<KillSwitchRecord>;
  disable(businessId: string, id: string, disabledBy: string): Promise<KillSwitchRecord>;
}

/**
 * Scope kinds the installed guard can actually act on. `EffectDispatcher` is the only place that
 * builds a `MutationContext`, so a switch scoped on a field it never populates would be accepted,
 * stored, shown as live, and stop nothing. Widen this only when a guard call site supplies the
 * field — `agent` and `model` have no meaning at the effect plane today.
 */
export const ENFORCEABLE_SCOPE_KINDS: readonly KillSwitchScopeKind[] = [
  "all_mutations",
  "tool",
  "provider",
  "integration",
  "destination",
  "data_class",
];

export type KillSwitchErrorCode =
  | "not_found"
  | "already_disabled"
  | "invalid_scope"
  | "unenforceable_scope";

export class KillSwitchError extends Error {
  constructor(
    readonly code: KillSwitchErrorCode,
    message: string
  ) {
    super(message);
    this.name = "KillSwitchError";
  }
}

export interface KillSwitchActor {
  readonly principalId: string;
  readonly correlationId?: string;
}

export interface EnableKillSwitchRequest {
  readonly scope: { readonly kind: KillSwitchScopeKind; readonly value?: string };
  readonly reasonCode: string;
}

function auditTarget(record: KillSwitchRecord): string {
  return record.scope.value === undefined
    ? `kill_switch:${record.scope.kind}`
    : `kill_switch:${record.scope.kind}:${record.scope.value}`;
}

/** Operator-facing emergency stops: validate, persist, and leave evidence of who flipped what. */
export class KillSwitchService {
  constructor(
    private readonly repo: KillSwitchStorePort,
    private readonly audit?: AuditRecorder,
    private readonly businessId: string = DEPLOYMENT_BUSINESS_ID,
    private readonly newId: () => string = () => crypto.randomUUID()
  ) {}

  /** Which scopes an operator may choose, so the UI cannot offer one that enforces nothing. */
  enforceableScopeKinds(): readonly KillSwitchScopeKind[] {
    return ENFORCEABLE_SCOPE_KINDS;
  }

  async list(): Promise<readonly KillSwitchRecord[]> {
    return this.repo.list(this.businessId);
  }

  async enable(
    request: EnableKillSwitchRequest,
    actor: KillSwitchActor
  ): Promise<KillSwitchRecord> {
    if (!ENFORCEABLE_SCOPE_KINDS.includes(request.scope.kind)) {
      throw new KillSwitchError(
        "unenforceable_scope",
        `no guard evaluates ${request.scope.kind}; the switch would stop nothing`
      );
    }
    // Checked here as well as by the storage CHECK: a scope value paired with the wrong kind is a
    // domain error the operator must see as such, not a constraint violation surfaced from SQL.
    const hasValue = request.scope.value !== undefined && request.scope.value.length > 0;
    if ((request.scope.kind === "all_mutations") === hasValue) {
      throw new KillSwitchError(
        "invalid_scope",
        request.scope.kind === "all_mutations"
          ? "all_mutations stops every mutating effect and takes no scope value"
          : `${request.scope.kind} needs a scope value naming what to stop`
      );
    }
    const record = await this.run(() =>
      this.repo.enable({
        businessId: this.businessId,
        id: this.newId(),
        scope: request.scope,
        reasonCode: request.reasonCode,
        enabledBy: actor.principalId,
      })
    );
    await this.record("kill_switch.enabled", record, actor);
    return record;
  }

  async disable(id: string, actor: KillSwitchActor): Promise<KillSwitchRecord> {
    const record = await this.run(() => this.repo.disable(this.businessId, id, actor.principalId));
    await this.record("kill_switch.disabled", record, actor);
    return record;
  }

  /**
   * The guard's own audit hook. A denial is the switch doing its job, so it is evidence in its own
   * right — recorded with `deny`, separately from the operator action that armed the switch.
   */
  auditPort(): KillSwitchAuditPort {
    return {
      record: async (evidence: KillSwitchAuditEvidence): Promise<void> => {
        await this.audit?.recordOrWarn({
          actorId: null,
          action: evidence.action,
          target: `kill_switch:${evidence.switchId}`,
          decision: evidence.decision,
          reasonCodes: [evidence.reasonCode],
          ...(evidence.runId === undefined ? {} : { runId: evidence.runId }),
          safeMetadata: {
            scopeKind: evidence.scopeKind,
            ...(evidence.stateId === undefined ? {} : { stateId: evidence.stateId }),
            ...(evidence.effectId === undefined ? {} : { effectId: evidence.effectId }),
            ...(evidence.toolId === undefined ? {} : { toolId: evidence.toolId }),
          },
        });
      },
    };
  }

  /** Records after the change lands; audit trouble must not undo a stop that is already live. */
  private async record(
    action: string,
    switchRecord: KillSwitchRecord,
    actor: KillSwitchActor
  ): Promise<void> {
    await this.audit?.recordOrWarn({
      actorId: actor.principalId,
      action,
      target: auditTarget(switchRecord),
      reasonCodes: [switchRecord.reasonCode],
      ...(actor.correlationId === undefined ? {} : { correlationId: actor.correlationId }),
      safeMetadata: { switchId: switchRecord.id, scopeKind: switchRecord.scope.kind },
    });
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof KillSwitchStoreError) {
        throw new KillSwitchError(error.code, error.message);
      }
      throw error;
    }
  }
}
