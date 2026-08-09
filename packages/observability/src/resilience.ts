import type { Attributes, Span, TelemetryPort } from "./ports";

const REDACTED = "[redacted]";
const PROTECTED_KEY =
  /(authorization|cookie|credential|secret|token|password|prompt|content|body|args|result|payload)|(^|[._-])(statement|subject|query|entity|entities)($|[._-])/i;

export type TelemetryBoundary =
  | "request"
  | "event"
  | "run"
  | "state"
  | "effect"
  | "model"
  | "integration"
  | "sandbox";

export interface CorrelationContext {
  readonly businessId?: string;
  readonly requestId?: string;
  readonly eventId?: string;
  readonly runId?: string;
  readonly stateId?: string;
  readonly effectId?: string;
  readonly integrationId?: string;
  readonly auditCorrelationId?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

function safeAttributeValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

/** Removes protected values and rejects structured payloads before telemetry export. */
export function redactAttributes(input: Readonly<Record<string, unknown>>): Attributes {
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (PROTECTED_KEY.test(key)) {
      attributes[key] = REDACTED;
      continue;
    }
    const safe = safeAttributeValue(value);
    if (safe !== undefined) attributes[key] = safe;
  }
  return attributes;
}

function correlationAttributes(context: CorrelationContext): Attributes {
  return redactAttributes({
    "tulipfarm.business_id": context.businessId,
    "tulipfarm.request_id": context.requestId,
    "tulipfarm.event_id": context.eventId,
    "tulipfarm.run_id": context.runId,
    "tulipfarm.state_id": context.stateId,
    "tulipfarm.effect_id": context.effectId,
    "tulipfarm.integration_id": context.integrationId,
    "tulipfarm.audit_correlation_id": context.auditCorrelationId,
    ...context.attributes,
  });
}

const NOOP_SPAN: Span = {
  setAttributes: () => undefined,
  recordError: () => undefined,
  end: () => undefined,
};

function startSpanSafely(
  telemetry: TelemetryPort,
  boundary: TelemetryBoundary,
  context: CorrelationContext
): Span {
  try {
    return telemetry.startSpan(`tulipfarm.${boundary}`, correlationAttributes(context));
  } catch {
    return NOOP_SPAN;
  }
}

/**
 * Traces one protected boundary. Telemetry is deliberately best-effort: exporter
 * failures never change the operation result or mask the operation error.
 */
export async function traceBoundary<T>(
  telemetry: TelemetryPort,
  boundary: TelemetryBoundary,
  context: CorrelationContext,
  operation: () => Promise<T>
): Promise<T> {
  const span = startSpanSafely(telemetry, boundary, context);
  try {
    return await operation();
  } catch (error) {
    try {
      span.recordError("operation_failed");
    } catch {
      // Telemetry must never mask the protected operation error.
    }
    throw error;
  } finally {
    try {
      span.end();
    } catch {
      // Export failure is operationally degraded, not a correctness failure.
    }
  }
}

export type IncidentSeverity = "info" | "warning" | "critical";

export interface IncidentInput {
  readonly component: string;
  readonly code: string;
  readonly scope: string;
  readonly severity: IncidentSeverity;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface GroupedIncident {
  readonly id: string;
  readonly component: string;
  readonly code: string;
  readonly scope: string;
  readonly severity: IncidentSeverity;
  readonly occurrences: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly metadata: Attributes;
}

const SEVERITY_ORDER: Readonly<Record<IncidentSeverity, number>> = {
  info: 0,
  warning: 1,
  critical: 2,
};

function fingerprint(input: IncidentInput): string {
  const value = `${input.component}\u0000${input.code}\u0000${input.scope}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `incident-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** In-memory projection helper; durable incident rows remain an adapter responsibility. */
export class IncidentGrouper {
  private readonly incidents = new Map<string, GroupedIncident>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  record(input: IncidentInput): GroupedIncident {
    const id = fingerprint(input);
    const at = this.now().toISOString();
    const existing = this.incidents.get(id);
    const incident: GroupedIncident = {
      id,
      component: input.component,
      code: input.code,
      scope: input.scope,
      severity:
        existing && SEVERITY_ORDER[existing.severity] > SEVERITY_ORDER[input.severity]
          ? existing.severity
          : input.severity,
      occurrences: (existing?.occurrences ?? 0) + 1,
      firstSeenAt: existing?.firstSeenAt ?? at,
      lastSeenAt: at,
      metadata: redactAttributes(input.metadata ?? {}),
    };
    this.incidents.set(id, incident);
    return incident;
  }
}

export interface ReadinessCapability {
  readonly id: string;
  readonly available: boolean;
  readonly required: boolean;
}

export interface ReadinessSummary {
  readonly status: "ready" | "degraded" | "unavailable";
  readonly ready: boolean;
  readonly unavailable: readonly string[];
}

export function readinessFromCapabilities(
  capabilities: readonly ReadinessCapability[]
): ReadinessSummary {
  const unavailable = capabilities
    .filter((capability) => !capability.available)
    .map((capability) => capability.id)
    .sort();
  const requiredUnavailable = capabilities.some(
    (capability) => capability.required && !capability.available
  );
  return {
    status: requiredUnavailable ? "unavailable" : unavailable.length > 0 ? "degraded" : "ready",
    ready: !requiredUnavailable,
    unavailable,
  };
}

export type KillSwitchScopeKind =
  | "agent"
  | "routine"
  | "tool"
  | "provider"
  | "integration"
  | "destination"
  | "model"
  | "data_class"
  | "all_mutations";

export interface KillSwitch {
  readonly id: string;
  readonly businessId: string;
  readonly scope: {
    readonly kind: KillSwitchScopeKind;
    readonly value?: string;
  };
  readonly reasonCode: string;
  readonly enabledAt: string;
  readonly enabledBy: string;
}

export interface MutationContext {
  readonly businessId: string;
  readonly mutation: boolean;
  readonly runId?: string;
  readonly stateId?: string;
  readonly effectId?: string;
  readonly agentId?: string;
  readonly routineId?: string;
  readonly toolId?: string;
  readonly provider?: string;
  readonly integrationId?: string;
  readonly destination?: string;
  readonly model?: string;
  readonly dataClasses: readonly string[];
}

export interface KillSwitchStore {
  listEnabled(businessId: string): Promise<readonly KillSwitch[]>;
}

export interface KillSwitchAuditEvidence {
  readonly action: "kill_switch.denied";
  readonly businessId: string;
  readonly decision: "deny";
  readonly switchId: string;
  readonly scopeKind: KillSwitchScopeKind;
  readonly reasonCode: string;
  readonly runId?: string;
  readonly stateId?: string;
  readonly effectId?: string;
  readonly toolId?: string;
}

export interface KillSwitchAuditPort {
  record(evidence: KillSwitchAuditEvidence): Promise<void>;
}

export interface MutationGuard {
  assertAllowed(context: MutationContext): Promise<void>;
}

export class KillSwitchDeniedError extends Error {
  constructor(
    readonly switchId: string,
    readonly scopeKind: KillSwitchScopeKind,
    readonly reasonCode: string
  ) {
    super(`mutation denied by kill switch ${switchId}`);
    this.name = "KillSwitchDeniedError";
  }
}

function matches(killSwitch: KillSwitch, context: MutationContext): boolean {
  const value = killSwitch.scope.value;
  switch (killSwitch.scope.kind) {
    case "all_mutations":
      return context.mutation;
    case "agent":
      return value !== undefined && context.agentId === value;
    case "routine":
      return value !== undefined && context.routineId === value;
    case "tool":
      return value !== undefined && context.toolId === value;
    case "provider":
      return value !== undefined && context.provider === value;
    case "integration":
      return value !== undefined && context.integrationId === value;
    case "destination":
      return value !== undefined && context.destination === value;
    case "model":
      return value !== undefined && context.model === value;
    case "data_class":
      return value !== undefined && context.dataClasses.includes(value);
  }
}

export class MutationKillSwitchGuard implements MutationGuard {
  constructor(
    private readonly deps: {
      readonly listEnabled: KillSwitchStore["listEnabled"];
      readonly audit: KillSwitchAuditPort;
    }
  ) {}

  async assertAllowed(context: MutationContext): Promise<void> {
    if (!context.mutation) return;

    let enabled: readonly KillSwitch[];
    try {
      enabled = await this.deps.listEnabled(context.businessId);
    } catch {
      throw new KillSwitchDeniedError(
        "state-unavailable",
        "all_mutations",
        "kill_switch_state_unavailable"
      );
    }

    const active = enabled.find(
      (killSwitch) => killSwitch.businessId === context.businessId && matches(killSwitch, context)
    );
    if (!active) return;

    const evidence: KillSwitchAuditEvidence = {
      action: "kill_switch.denied",
      businessId: context.businessId,
      decision: "deny",
      switchId: active.id,
      scopeKind: active.scope.kind,
      reasonCode: active.reasonCode,
      runId: context.runId,
      stateId: context.stateId,
      effectId: context.effectId,
      toolId: context.toolId,
    };
    try {
      await this.deps.audit.record(evidence);
    } catch {
      // The protected mutation remains denied even when audit export is degraded.
    }
    throw new KillSwitchDeniedError(active.id, active.scope.kind, active.reasonCode);
  }
}
