/** Local Tool definition shape with the authority metadata the Effect Plane gates on. */

import { createHash } from "node:crypto";
import type { ToolContractDefinition, ToolContractSpec } from "@tulipfarm/schema";
import { type PublishedToolContract, publishToolContract } from "./contract";
import type { ToolTargetRef } from "./intent";

/** `user` never falls back to service; `user_preferred` uses service only unattended. */
export type ToolCredentialMode = "user" | "service" | "user_preferred";

export type ToolPrincipalKind =
  | "user"
  | "agent"
  | "routine"
  | "integration_adapter"
  | "api"
  | "service";

/** Visibility only, not authorization; legacy name lists still apply until adapters use this. */
export interface ToolAvailability {
  readonly principalKinds?: readonly ToolPrincipalKind[];
  readonly requiresPresentation?: boolean;
  /** Browser Chat only; these require a browser the caller is looking at. */
  readonly requiresWebChat?: boolean;
  readonly agentIds?: readonly string[];
}

export interface ToolAuthorization<Ctx = unknown> {
  readonly action: string;
  /** Resource names required regardless of arguments. */
  readonly resources?: readonly string[];
  /**
   * Pure and total over arbitrary JSON; returning [] leaves static resources as the only check.
   */
  readonly targets?: (args: unknown, ctx: Ctx | undefined) => readonly ToolTargetRef[];
  readonly dataClasses?: readonly string[];
  /** Empty egress list denies every destination; absent imposes no limit. */
  readonly allowedDestinations?: readonly string[];
}

export type ToolDefinitionTier = "system" | "platform" | "integration";

export type ToolDefinitionRisk = "low" | "medium" | "high";

export type ToolDefinitionIdempotency = "provider" | "reconcile" | "none";

export interface ToolRetryPolicy {
  readonly maxAttempts: number;
  /** False when a repeated failed attempt would be observable and not provider-deduped. */
  readonly safeToRetry: boolean;
}

export interface ToolTimeoutPolicy {
  readonly activeMs?: number;
  readonly wallClockMs?: number;
}

/** Reconciliation names read-back for ambiguous effects; compensation names undo. */
export interface ToolCompensationPolicy {
  readonly operation?: string;
  readonly reconciliation?: string;
}

export interface DefineToolInput<Ctx, Result> {
  readonly name: string;
  readonly description: string;
  readonly mutating: boolean;
  readonly tier: ToolDefinitionTier;
  readonly inputSchema: Record<string, unknown>;
  readonly inputSchemaFor?: (ctx: Ctx) => Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly authorization: ToolAuthorization<Ctx>;
  readonly riskClass?: ToolDefinitionRisk;
  readonly credentialMode?: ToolCredentialMode;
  readonly provider?: string;
  readonly availableTo?: ToolAvailability;
  readonly idempotency?: ToolDefinitionIdempotency;
  readonly retry?: ToolRetryPolicy;
  readonly timeout?: ToolTimeoutPolicy;
  readonly compensation?: ToolCompensationPolicy;
  readonly version?: string;
  readonly requiresApproval?: boolean;
  readonly handler: (args: unknown, ctx: Ctx) => Promise<Result>;
}

export interface ToolDefinition<Ctx, Result> extends DefineToolInput<Ctx, Result> {
  readonly riskClass: ToolDefinitionRisk;
  readonly credentialMode: ToolCredentialMode;
  readonly idempotency: ToolDefinitionIdempotency;
  readonly version: string;
  targetsFor(args: unknown, ctx?: Ctx): readonly ToolTargetRef[];
}

/** Derived targets must include every static resource or they can bypass the grant floor. */
function assertTargetsCoverResources(
  tool: string,
  resources: readonly string[],
  refs: readonly ToolTargetRef[]
): void {
  if (refs.length === 0) return;
  const derivedTypes = new Set(refs.map((ref) => ref.type));
  const dropped = resources.filter((resource) => !derivedTypes.has(resource));
  if (dropped.length === 0) return;
  throw new ToolDefinitionError(
    tool,
    `authorization.targets derived [${[...derivedTypes].join(", ")}] but dropped declared ` +
      `resource(s) [${dropped.join(", ")}]. Derived targets replace static resources at the gate, ` +
      "so a derivation must also name each declared resource or that resource stops being checked."
  );
}

export class ToolDefinitionError extends Error {
  constructor(
    readonly tool: string,
    reason: string
  ) {
    super(`${tool}: ${reason}`);
    this.name = "ToolDefinitionError";
  }
}

/** Mutating external Tools need provider idempotency or reconciliation for ambiguous failures. */
function assertIdempotencyCoherent(
  name: string,
  mutating: boolean,
  idempotency: ToolDefinitionIdempotency
): void {
  if (mutating && idempotency === "none") {
    throw new ToolDefinitionError(
      name,
      "a mutating Tool must declare idempotency 'provider' or 'reconcile'"
    );
  }
}

/** Provider `idempotency: "reconcile"` without read-back parks as `reconciliation_required`. */
/** Provider Tools must state idempotency; local effects rely on our transaction. */
function assertIdempotencyDeclared(
  name: string,
  mutating: boolean,
  provider: string | undefined,
  idempotency: ToolDefinitionIdempotency | undefined
): void {
  if (!mutating || provider === undefined || idempotency !== undefined) return;
  throw new ToolDefinitionError(
    name,
    `mutating Tool on provider "${provider}" must declare idempotency explicitly`
  );
}

const TOOL_NAME = /^[a-z][a-z0-9_]*$/;
/** Accepts snake_case and kebab-case to match grants and third-party OpenAPI names. */
export const RESOURCE_NAME_PATTERN = "^[a-z][a-z0-9_-]*(\\.[a-z0-9_*-]+)?$";
export const ACTION_NAME_PATTERN = "^[a-z][a-z0-9_-]*(\\.[a-z][a-z0-9_-]*)+$";
const RESOURCE_NAME = new RegExp(RESOURCE_NAME_PATTERN);
const ACTION_NAME = new RegExp(ACTION_NAME_PATTERN);
const TARGET_TYPE = /^([a-z][a-z0-9_-]*)(?:\.([A-Za-z0-9_-]+))?$/;
const TARGET_ID_SENTINELS = new Set(["*"]);

function targetTypeOf(tool: string, ref: ToolTargetRef): string {
  const match = TARGET_TYPE.exec(ref.type);
  if (match === null) {
    throw new ToolDefinitionError(tool, `target type "${ref.type}" is not a valid name`);
  }
  const [, namespace, segment] = match;
  return segment === undefined ? namespace : `${namespace}.${segment.toLowerCase()}`;
}

function safeTargetRef(tool: string, ref: ToolTargetRef): ToolTargetRef | undefined {
  if (
    typeof ref?.id !== "string" ||
    ref.id.length === 0 ||
    ref.id === "undefined" ||
    ref.id === "null"
  ) {
    return undefined;
  }
  if (TARGET_ID_SENTINELS.has(ref.id)) {
    throw new ToolDefinitionError(tool, `target id "${ref.id}" is reserved for grant wildcards`);
  }
  if (typeof ref.type !== "string") {
    throw new ToolDefinitionError(tool, "target type must be a string");
  }
  if (ref.domain !== undefined && (typeof ref.domain !== "string" || ref.domain.length === 0)) {
    throw new ToolDefinitionError(tool, "target domain must be a non-empty string when present");
  }
  return {
    type: targetTypeOf(tool, ref),
    id: ref.id,
    ...(ref.domain === undefined ? {} : { domain: ref.domain }),
  };
}

export function defineTool<Ctx, Result>(
  input: DefineToolInput<Ctx, Result>
): ToolDefinition<Ctx, Result> {
  if (!TOOL_NAME.test(input.name)) {
    throw new ToolDefinitionError(input.name, "name must be lower_snake_case");
  }
  if (input.authorization.action.length === 0) {
    throw new ToolDefinitionError(input.name, "authorization.action is required");
  }
  if (!ACTION_NAME.test(input.authorization.action)) {
    throw new ToolDefinitionError(
      input.name,
      `action "${input.authorization.action}" must use dotted authorization vocabulary so a grant can reference it`
    );
  }
  const resources = [...new Set(input.authorization.resources ?? [])];
  for (const resource of resources) {
    if (!RESOURCE_NAME.test(resource)) {
      throw new ToolDefinitionError(input.name, `resource "${resource}" is not a valid name`);
    }
  }
  if (input.provider === undefined && input.credentialMode !== undefined) {
    throw new ToolDefinitionError(
      input.name,
      "credentialMode is meaningless without a provider to spend a credential on"
    );
  }
  // Never infer provider credentials: `service` is the most privileged, least attributable option.
  if (input.provider !== undefined && input.credentialMode === undefined) {
    throw new ToolDefinitionError(
      input.name,
      `provider "${input.provider}" requires an explicit credentialMode`
    );
  }

  // Local effects spend deployment authority, not a person's provider token.
  const credentialMode = input.credentialMode ?? "service";
  assertIdempotencyDeclared(input.name, input.mutating, input.provider, input.idempotency);
  const idempotency = input.idempotency ?? (input.mutating ? "reconcile" : "none");
  assertIdempotencyCoherent(input.name, input.mutating, idempotency);

  const targets = input.authorization.targets;
  return Object.freeze({
    ...input,
    authorization: { ...input.authorization, resources },
    riskClass: input.riskClass ?? (input.mutating ? "medium" : "low"),
    credentialMode,
    idempotency,
    version: input.version ?? "1",
    targetsFor(args: unknown, ctx?: Ctx): readonly ToolTargetRef[] {
      if (targets === undefined) return [];
      // Derivation failures are definition defects, not provider outages.
      let derived: readonly ToolTargetRef[];
      try {
        derived = targets(args, ctx);
      } catch (cause) {
        throw new ToolDefinitionError(
          input.name,
          `authorization.targets threw on raw arguments: ${
            cause instanceof Error ? cause.message : String(cause)
          }`
        );
      }
      const refs: ToolTargetRef[] = [];
      for (const ref of derived) {
        // Absent arguments drop to static resources; invalid interpolated target grammar is a
        // definition defect, with uppercase folded to canonical lower case.
        const safe = safeTargetRef(input.name, ref);
        if (safe !== undefined) refs.push(safe);
      }
      assertTargetsCoverResources(input.name, resources, refs);
      return Object.freeze(refs);
    },
  });
}

/** Projects local definitions into the imported Tool contract shape for one catalog/gate path. */
export function toolContractSpecOf<Ctx, Result>(
  definition: ToolDefinition<Ctx, Result>
): ToolContractSpec {
  const auth = definition.authorization;
  return {
    toolId: definition.name,
    toolVersion: definition.version,
    description: definition.description,
    action: auth.action,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema ?? { type: "object", additionalProperties: true },
    riskClass: definition.riskClass,
    mutating: definition.mutating,
    requiredActions: [auth.action],
    requiredResources: [...(auth.resources ?? [])],
    dataClasses: [...(auth.dataClasses ?? [])],
    allowedDestinations: [...(auth.allowedDestinations ?? [])],
    dryRun: false,
    idempotency: { strategy: definition.idempotency },
    ...(definition.retry === undefined ? {} : { retry: { ...definition.retry } }),
    ...(definition.timeout === undefined ? {} : { timeout: { ...definition.timeout } }),
    ...(definition.compensation === undefined
      ? {}
      : { compensation: { ...definition.compensation } }),
    adapter: {
      kind: definition.provider === undefined ? "native" : "integration",
      ref: definition.provider ?? definition.name,
    },
  };
}

/** Local Tool digests derive from the spec so effects stay tied to the authorized contract. */
export function publishLocalToolContract<Ctx, Result>(
  definition: ToolDefinition<Ctx, Result>
): PublishedToolContract {
  const spec = toolContractSpecOf(definition);
  const digest = createHash("sha256").update(canonicalJson(spec)).digest("hex");
  return publishToolContract({
    apiVersion: "tulipfarm.ai/v1",
    kind: "ToolContract",
    metadata: {
      id: `local:${spec.toolId}`,
      slug: spec.toolId.replaceAll("_", "-"),
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
      publishedDigest: digest,
    },
    spec,
  } as ToolContractDefinition);
}

/** Key order is not part of a contract's identity, so the digest must not depend on it. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}
