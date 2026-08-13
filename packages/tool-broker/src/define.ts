/**
 * `defineTool` — the one shape every Tool declares itself in (D8).
 *
 * Before this existed there were nine structurally-identical `*Tool` interfaces across eleven
 * modules, each hand-adapted into `ToolDef` by a `switch`-like wall of registration boilerplate.
 * They differed only in the type of the context their handler received, and none of them had
 * anywhere to record the one thing the Effect Plane actually needs: **what authority this call
 * requires**. A tool could not state that it writes `record.leave_request` rather than `record.*`,
 * so the gate had nothing to decide on even where a gate existed.
 *
 * This module keeps the handler signature untouched — modules still close over their own services
 * and receive their own context type — and adds the declaration around it. Migration is therefore
 * mechanical and behaviour-preserving, which is what lets the whole tool surface move in one wave.
 *
 * The generic parameters carry their weight:
 * - `Ctx` stays module-specific so no module has to flatten its service bundle into a shared shape.
 * - `Result` is generic because the canonical result type lives in the API app, and this package
 *   must not depend on an app. The broker never inspects a result; it only routes one.
 */

import { createHash } from "node:crypto";
import type { ToolContractDefinition, ToolContractSpec } from "@tulipfarm/schema";
import { type PublishedToolContract, publishToolContract } from "./contract";
import type { ToolTargetRef } from "./intent";

/**
 * Where the credential for an outbound call comes from (D7).
 *
 * This is the field that decides whether a provider's own ACL can protect anything. Today every
 * integration holds one business-wide service credential, so GitHub sees the bot on every call and
 * cannot tell an engineer from someone in HR. A tool that declares `user` or `user_preferred` opts
 * into acting as the calling human, which makes the provider — not us — the authority on access.
 *
 * - `user` — the caller's own token, always. No personal token means the call is refused with a
 *   connect prompt; there is deliberately no bot fallback, because falling back would silently
 *   escalate the caller's authority to the bot's.
 * - `service` — the business credential, always. Correct where the bot must be the visible actor
 *   (a Slack post from the app) or where no human triggered the call at all.
 * - `user_preferred` — the caller's token when a human triggered the call and has connected one;
 *   the service credential for unattended work. The common case for GitHub, Drive and Jira.
 */
export type ToolCredentialMode = "user" | "service" | "user_preferred";

/** Principal kinds a Tool can be offered to. Mirrors `@tulipfarm/authz`'s `PrincipalKind`. */
export type ToolPrincipalKind =
  | "user"
  | "agent"
  | "routine"
  | "integration_adapter"
  | "api"
  | "service";

/**
 * Structural limits on who may ever be *offered* a Tool, independent of grants.
 *
 * Declares structural visibility limits, but this field is not consumed by the API adapter yet.
 * Until `toToolDef` projects it and the chat/tool registries read it, the legacy hard-coded
 * `PRESENTATION_TOOL_NAMES` / `WEB_ONLY_TOOL_NAMES` name lists remain the effective filters.
 *
 * This is a *visibility* filter, not an authorization decision. It narrows what is put in front of
 * a model. Authority is still decided per call by the gate — a tool that passes `availableTo` is
 * not thereby permitted.
 */
export interface ToolAvailability {
  /** Restrict to these principal kinds. Absent means every kind. */
  readonly principalKinds?: readonly ToolPrincipalKind[];
  /** Only offer when the turn renders to a surface that can present it (web chat, not Slack). */
  readonly requiresPresentation?: boolean;
  /**
   * Only offer on the browser Chat surface specifically.
   *
   * Distinct from `requiresPresentation`: an imperative client Tool such as `navigate_to` has no
   * meaning at all outside a browser the caller is looking at, whereas a presentation Tool merely
   * needs *some* surface able to render it. Slack can present; it cannot be navigated.
   */
  readonly requiresWebChat?: boolean;
  /** Only offer to these Agent ids. Absent means every Agent, subject to its own allowlist. */
  readonly agentIds?: readonly string[];
}

/**
 * What authority a call to this Tool requires.
 *
 * `targets` is the load-bearing member (D6). A static resource name can only ever express
 * "may write records"; the arguments are what distinguish an engineering ticket from an HR salary
 * record. Deriving targets from arguments is therefore the difference between a policy that can be
 * written and one that cannot.
 */
export interface ToolAuthorization<Ctx = unknown> {
  /** Verb checked against grants, e.g. `record.create`. Doubles as the contract's `action`. */
  readonly action: string;
  /**
   * Resource names required regardless of arguments, in the two-level grammar
   * (`platform.*`, `soul.*`, `record.<type>`, `authz.*`, `tool.<id>`, `integration.<slug>`).
   */
  readonly resources?: readonly string[];
  /**
   * Argument-derived targets. Returning `[]` means "this call names no specific resource", which
   * leaves the static `resources` above as the only check — correct for a tool that lists rather
   * than touches.
   *
   * Must be pure and total over *arbitrary JSON*. It runs before the handler, and nothing validates
   * arguments first — every handler runs its own AJV check as its first statement, and the
   * authorization gate calls this on raw model output. Never assume a field is present or typed.
   */
  readonly targets?: (args: unknown, ctx: Ctx | undefined) => readonly ToolTargetRef[];
  /** Sensitivity labels this Tool can read or emit, checked against grants and DLP. */
  readonly dataClasses?: readonly string[];
  /** Egress allowlist. An empty list denies every destination; absent imposes no limit. */
  readonly allowedDestinations?: readonly string[];
}

/** Tier a Tool is registered under. Mirrors the API app's `ToolTier`. */
export type ToolDefinitionTier = "system" | "platform" | "integration";

/** Risk band, mirroring `@tulipfarm/schema`'s `ToolRiskClass`. */
export type ToolDefinitionRisk = "low" | "medium" | "high";

/** How a repeated call with the same idempotency key is made safe. */
export type ToolDefinitionIdempotency = "provider" | "reconcile" | "none";

export interface ToolRetryPolicy {
  readonly maxAttempts: number;
  /**
   * Whether a *failed* attempt may be retried at all. False for any effect whose repetition is
   * observable and not deduplicated by the provider.
   */
  readonly safeToRetry: boolean;
}

/** Budgets a call must finish inside. Mirrors the published contract's `timeout`. */
export interface ToolTimeoutPolicy {
  readonly activeMs?: number;
  readonly wallClockMs?: number;
}

/**
 * How an ambiguous effect is resolved after the fact.
 *
 * `reconciliation` names the read-back operation `EffectReconciler` invokes to discover whether a
 * dispatched effect actually landed; without it an ambiguous failure parks as
 * `reconciliation_required` and waits for a human. `operation` names the inverse effect used to
 * undo one that did land.
 */
export interface ToolCompensationPolicy {
  readonly operation?: string;
  readonly reconciliation?: string;
}

export interface DefineToolInput<Ctx, Result> {
  readonly name: string;
  readonly description: string;
  /** Whether the Tool changes state anywhere. Drives approval, retry and idempotency rules. */
  readonly mutating: boolean;
  readonly tier: ToolDefinitionTier;
  /** Plain JSON Schema — fed to AJV before dispatch and to the model as the call signature. */
  readonly inputSchema: Record<string, unknown>;
  /** Narrows the schema per request without leaking cross-surface vocabulary into the base shape. */
  readonly inputSchemaFor?: (ctx: Ctx) => Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly authorization: ToolAuthorization<Ctx>;
  readonly riskClass?: ToolDefinitionRisk;
  readonly credentialMode?: ToolCredentialMode;
  /** Integration slug whose credential this Tool spends, e.g. `github`. Absent for local effects. */
  readonly provider?: string;
  readonly availableTo?: ToolAvailability;
  readonly idempotency?: ToolDefinitionIdempotency;
  readonly retry?: ToolRetryPolicy;
  readonly timeout?: ToolTimeoutPolicy;
  readonly compensation?: ToolCompensationPolicy;
  readonly version?: string;
  /** Forces a human decision before dispatch regardless of autonomy mode. */
  readonly requiresApproval?: boolean;
  readonly handler: (args: unknown, ctx: Ctx) => Promise<Result>;
}

export interface ToolDefinition<Ctx, Result> extends DefineToolInput<Ctx, Result> {
  readonly riskClass: ToolDefinitionRisk;
  readonly credentialMode: ToolCredentialMode;
  readonly idempotency: ToolDefinitionIdempotency;
  readonly version: string;
  /** Resolves this call's targets, always returning an array. */
  targetsFor(args: unknown, ctx?: Ctx): readonly ToolTargetRef[];
}

/**
 * A derived target set must not quietly drop the Tool's declared static resources.
 *
 * `authorizeToolIntent` treats derived targets and static `resources` as **alternatives, not
 * conjuncts**: it checks the derived refs when there are any, and falls back to the static
 * resources only when there are none. Deriving nothing is therefore fail-closed — the coarse
 * resource becomes the check. But the converse is a privilege escalation: the instant one ref
 * survives, every declared resource stops being checked at all, so a Tool that declares
 * `resources: ["record"]` and derives only `record.ticket` is authorized in full by a grant that
 * names nothing but tickets.
 *
 * Today every derivation in the repo avoids this by *including* the coarse target alongside the
 * narrow one — `recordAndRecordIdTargets` emits both `record` and `record.<type>`, and since the
 * gate requires **every** derived request to pass, that reinstates the static resource as a floor.
 * That is a convention, though, held only by the care of whoever wrote each derivation, and it is
 * invisible at the point where it would be broken. This makes it structural: if a derivation
 * returns anything at all, it must still name each declared resource, or it is a definition defect.
 *
 * It is deliberately not fixed by silently re-adding the missing resources. A bare `record` request
 * carries no `recordId`, so a grant scoped with `recordIds: ["ticket"]` would not match it, and
 * "repairing" the set here would deny calls that the Tool's author believed they had scoped
 * correctly. The author must say what they mean.
 */
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

/**
 * A mutating Tool must be able to survive a repeated delivery.
 *
 * `EffectDispatcher` cannot tell a lost response from a lost request, so it classifies a failure
 * after dispatch on a mutating Tool as *ambiguous* and parks it. That is only recoverable if the
 * Tool declared how a duplicate is absorbed — either the provider deduplicates on our key
 * (`provider`) or we can reconcile after the fact (`reconcile`). `none` on a mutating Tool is a
 * declaration that duplicates are silently acceptable, which is never true for an external effect.
 *
 * The published contract schema enforces the same rule; this check simply fails at definition time
 * with the tool's name attached rather than at publication with a schema path.
 */
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

/**
 * A Tool that claims it can be reconciled must say *how*.
 *
 * `EffectReconciler` reads `contract.compensation.reconciliation` to discover whether a dispatched
 * effect actually landed. When that is absent it cannot resolve the ambiguity and parks the effect
 * as `reconciliation_required`, waiting for a human. So `idempotency: "reconcile"` with no
 * reconciliation operation is a claim the declaration cannot back — it reads as recoverable and
 * behaves as stuck.
 *
 * Only enforced for Tools with a `provider`, because those are the ones that actually traverse
 * `EffectDispatcher`. A local effect's duplicate is absorbed by our own transaction, never by a
 * read-back against someone else's system.
 */
/**
 * A mutating Tool that reaches an external provider must state its idempotency explicitly.
 *
 * Defaulting here is the problem the review found: `reconcile` is a claim that an ambiguous effect
 * can be resolved by reading back from the provider, and nothing in the declaration proves it.
 * `EffectReconciler` needs `compensation.reconciliation` to actually do that — absent it, the effect
 * parks as `reconciliation_required` and waits for a human. That is safe, but it is not what
 * "reconcile" reads like, and no author should arrive there by omission.
 *
 * Not required for local effects: they never traverse `EffectDispatcher`, so their duplicate is
 * absorbed by our own transaction rather than by a read-back against someone else's system.
 *
 * Deliberately NOT requiring `compensation.reconciliation` outright — the published contract schema
 * requires only a strategy, and a third-party OpenAPI integration frequently has no read-back to
 * name. Demanding one would make honest integrations unpublishable.
 */
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
/**
 * Authorization vocabulary admits both `snake_case` and `kebab-case` segments, and that is
 * deliberate rather than lax.
 *
 * Actions and resources are the language *grants* are written in, so these patterns and the Role
 * artifact's (`packages/schema/src/definitions/role.ts`) must agree exactly — a Tool vocabulary
 * string no grant can express is a Tool no one can ever be given.
 *
 * We widened the Role schema rather than renaming the actions, because declarative Tool actions are
 * derived from *third-party* OpenAPI operation names we do not control. Forcing kebab there would
 * mean lossy normalisation and the collisions that come with it — the same trap integration slugs
 * already fell into. Accepting both is the only option that stays faithful to imported vocabulary.
 */
export const RESOURCE_NAME_PATTERN = "^[a-z][a-z0-9_-]*(\\.[a-z0-9_*-]+)?$";
export const ACTION_NAME_PATTERN = "^[a-z][a-z0-9_-]*(\\.[a-z][a-z0-9_-]*)+$";
const RESOURCE_NAME = new RegExp(RESOURCE_NAME_PATTERN);
const ACTION_NAME = new RegExp(ACTION_NAME_PATTERN);
/** A dynamically derived target type, which may carry a second level built from an argument. */
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
  // Defaulting a provider-bearing Tool to `service` would silently pick the shared business
  // credential — the most privileged and least attributable option, and the exact failure this
  // module exists to prevent (the provider sees the bot on every call and cannot tell an engineer
  // from someone in HR). Whose authority is spent is never a safe thing to infer.
  if (input.provider !== undefined && input.credentialMode === undefined) {
    throw new ToolDefinitionError(
      input.name,
      `provider "${input.provider}" requires an explicit credentialMode`
    );
  }

  // A local effect has no provider to authenticate against, so `service` is the honest default:
  // it spends this deployment's own authority, not a person's.
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
      // A derivation that throws must not become a dispatch failure that reads like a provider
      // outage. It is a definition defect, and it is reported as one.
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
        // A ref built from an absent argument (`String(undefined)`) names no real resource. Passing
        // it on would ask the gate to decide about `record:undefined`; dropping it leaves the
        // Tool's static `resources` as the check, which fails closed.
        //
        // Invalid target types are different. Their second level is often interpolated from a
        // caller-supplied argument (`record.${args.type}`). Uppercase is folded to the canonical
        // lower-case grant vocabulary, but separators (`.`/`:`) and `*` are surfaced as definition
        // defects: they cannot be safely interpolated into a dotted grammar.
        const safe = safeTargetRef(input.name, ref);
        if (safe !== undefined) refs.push(safe);
      }
      assertTargetsCoverResources(input.name, resources, refs);
      return Object.freeze(refs);
    },
  });
}

/**
 * Projects a definition into the authored contract shape so a locally-defined Tool and an imported
 * one (OpenAPI, MCP, third-party manifest) are indistinguishable to the catalog and the gate.
 *
 * That equivalence is the point of the whole framework: it is what lets an external Tool ride the
 * same rails without a second code path to authorize, meter and reconcile it.
 */
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

/**
 * Publishes a locally-defined Tool's contract directly, without the Soul publication ceremony.
 *
 * The framework's claim is that a locally-defined Tool and an imported one (OpenAPI, MCP,
 * third-party manifest) are indistinguishable to the catalog and the gate. An imported contract
 * arrives as a Soul artifact and earns its `publishedDigest` by being published; a local one has no
 * such lifecycle to pass through, because the definition *is* the source — there is no authored
 * document that could disagree with it.
 *
 * Requiring a lifecycle it cannot have would leave only two options at the gate, and both are
 * worse: fabricate a "published" envelope at every call site (so the ceremony proves nothing), or
 * let a Tool with no contract execute unchecked (so the gate is optional). This makes the third
 * option explicit and gives it one implementation.
 *
 * The digest is derived from the spec rather than assigned, so it identifies exactly the contract
 * that was authorized against — a Tool whose declaration changes gets a different digest, and any
 * effect recorded under the old one stays attributable to the contract that actually allowed it.
 */
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
