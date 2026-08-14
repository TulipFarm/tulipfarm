import { createHash } from "node:crypto";
import {
  type CompiledEgressTool,
  compileOpenApiEgress,
  type EgressHttpPort,
  OpenApiToolAdapter,
} from "@tulipfarm/integrations";
import {
  type SecretAuthorizer,
  SecretBroker,
  type SecretProvider,
  type SecretsService,
} from "@tulipfarm/secrets";
import type { Logger, SoulIntegration } from "@tulipfarm/soul";
import { isPersonalCredentialStep, resolveAuthSteps } from "@tulipfarm/soul";
import {
  CredentialDispatcher,
  EffectDispatcher,
  type EffectStore,
  intentDigest,
  normalizeToolIntent,
  type ToolAdapter,
  ToolCatalog,
  type ToolCredentialMode,
  ToolDispatchError,
  type ToolTargetRef,
} from "@tulipfarm/tool-broker";
import { integrationSecretKey, isSecretRef } from "../../integrations/connection-env";
import { principalSecretKey } from "../../integrations/principal-tokens";
import { defineApiTool, toToolDef } from "../define";
import { err, ok, type RequestContext, type ToolCallResult, type ToolDef } from "../types";

/** Compiles manifest egress into governed chat Tools with the ledgered dispatch path. */

/** Tool names are namespaced by slug so two integrations may both publish `search`. */
export function declarativeToolName(slug: string, toolName: string): string {
  return `${definitionSlug(slug)}_${toolName}`;
}

/** The secret ref a compiled tool's credential lease resolves through. */
export function egressSecretRef(slug: string, tokenEnv: string): string {
  return `secret://integrations/${slug}/egress/${tokenEnv}`;
}

/** Principal refs derive from business refs to keep credentials per-call. */
export function principalEgressSecretRef(
  slug: string,
  tokenEnv: string,
  principal: { readonly kind: string; readonly id: string }
): string {
  return `${egressSecretRef(slug, tokenEnv)}/principal/${principal.kind}/${principal.id}`;
}

/** Reads back the principal a ref names, or `null` for the business-wide form. */
function principalOfRef(
  businessRef: string,
  secretRef: string
): { kind: string; id: string } | null {
  if (!secretRef.startsWith(`${businessRef}/principal/`)) return null;
  const [kind, ...rest] = secretRef.slice(`${businessRef}/principal/`.length).split("/");
  const id = rest.join("/");
  return kind === undefined || kind === "" || id === "" ? null : { kind, id };
}

/** Dresses a digest as an RFC 4122 v4 uuid, the same technique `../slack/tools.ts` uses. */
function derivedId(...parts: readonly string[]): string {
  const digest = createHash("sha256").update(parts.join(":")).digest("hex");
  const version = `4${digest.slice(13, 16)}`;
  const variant = ((Number.parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    version,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function mapDispatchError(error: ToolDispatchError, slug: string): ToolCallResult {
  switch (error.detail) {
    case "provider_unauthorized":
      return err(
        "internal_error",
        `${slug} rejected the credential — reconnect the integration to refresh it.`
      );
    case "provider_not_found":
      return err("not_found", `${slug} has no such record.`);
    // Transient by definition, and the ledger has already spent this contract's retry budget on
    // it. Classifying it as infrastructure is what keeps the model from treating a busy provider
    // as a malformed request and rewording arguments that were never wrong.
    case "provider_rate_limited":
      return err("unavailable", `${slug} is rate limiting this call; try again shortly.`);
    case "provider_unavailable":
      return err("unavailable", `${slug} is temporarily unavailable; try again shortly.`);
    case "credential_missing":
    case "credential_denied":
      return err("internal_error", `${slug} is not connected.`);
    default:
      return err("internal_error", error.detail ? `${error.code}:${error.detail}` : error.message);
  }
}

/** Rediscovered ledger effects cannot replay provider output; only settled state is stored. */
function replayed(state: string): ToolCallResult {
  if (state === "confirmed") {
    return ok({ replayed: true, note: "This call already completed; not repeated." });
  }
  return err("internal_error", `effect_${state}`);
}

function declarationSlug(slug: string): string {
  return slug.replace(/\./g, "-");
}

const SLUG_PREFIX = "i_";

function encodeSlug(slug: string): string {
  return [...slug].map((char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

function definitionSlug(slug: string): string {
  const normalized = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized.length === 0) return `${SLUG_PREFIX}${encodeSlug(slug) || "empty"}`;
  if (/^[a-z]/.test(normalized)) return normalized;
  // `i_` marks an integration slug that needed a leading letter; collisions are rejected at build.
  return `${SLUG_PREFIX}${normalized}`;
}

function integrationResource(slug: string): string {
  return `integration.${declarationSlug(slug)}`;
}

/** Resolve auth steps before credential mode so legacy `oauth` keeps personal credentials. */
function credentialModeFor(integration: SoulIntegration): ToolCredentialMode {
  const personal = resolveAuthSteps(integration.manifest).some(isPersonalCredentialStep);
  return personal ? "user_preferred" : "service";
}

const TARGET_FIELD_KINDS: Readonly<Record<string, string>> = {
  block_id: "block",
  channel: "channel",
  channel_id: "channel",
  chat_id: "chat",
  database_id: "database",
  documentId: "document",
  fileId: "file",
  page_id: "page",
  repository: "repository",
  repo: "repository",
  spaceId: "space",
  spaceKey: "space",
  user_id: "user",
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function valueAt(source: unknown, path: readonly string[]): unknown {
  let cursor = source;
  for (const segment of path) {
    const container = record(cursor);
    if (container === undefined) return undefined;
    cursor = container[segment];
  }
  return cursor;
}

function targetKind(field: string, toolName: string): string | undefined {
  const explicit = TARGET_FIELD_KINDS[field];
  if (explicit !== undefined) return explicit;
  if (field === "id" && toolName.includes("page")) return "page";
  if ((field === "id" || field === "keys") && toolName.includes("space")) return "space";
  if (field.endsWith("_id")) return field.slice(0, -3).replace(/_/g, "-");
  if (field.endsWith("Id")) {
    return field
      .slice(0, -2)
      .replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
      .replace(/^-/, "");
  }
  return undefined;
}

function targetValues(args: unknown, field: string): readonly unknown[] {
  const source = record(args);
  const direct = source?.[field];
  const body = valueAt(args, ["body", field]);
  const parent = valueAt(args, ["body", "parent", field]);
  return [direct, body, parent].filter((value) => value !== undefined);
}

function appendTarget(
  targets: ToolTargetRef[],
  seen: Set<string>,
  type: string,
  kind: string,
  value: unknown
): void {
  if (Array.isArray(value)) {
    for (const entry of value) appendTarget(targets, seen, type, kind, entry);
    return;
  }
  if (typeof value !== "string" && typeof value !== "number") return;
  const raw = String(value);
  if (raw.length === 0) return;
  const id = `${kind}:${raw}`;
  const key = `${type}\0${id}`;
  if (seen.has(key)) return;
  seen.add(key);
  targets.push({ type, id });
}

function declarativeTargets(
  compiled: CompiledEgressTool,
  slug: string,
  args: unknown
): readonly ToolTargetRef[] {
  const fields = new Set([
    ...compiled.binding.params.map((param) => param.name),
    ...Object.keys(TARGET_FIELD_KINDS),
  ]);
  const targets: ToolTargetRef[] = [];
  const seen = new Set<string>();
  const resource = `integration.${declarationSlug(slug)}`;
  for (const field of fields) {
    const kind = targetKind(field, compiled.name);
    if (kind === undefined) continue;
    // See `../github/tools.ts`: the gate's namespace is the Tool's declared resource, so the kind
    // moves into the id where `recordSelector` scopes it. Keeping it in the type would make every
    // declarative target unmatchable by an `integration.<slug>` grant.
    for (const value of targetValues(args, field)) {
      appendTarget(targets, seen, resource, kind, value);
    }
  }
  return targets;
}

/** Resolves egress credentials from sealed connection env. */
class EgressSecretProvider implements SecretProvider {
  constructor(
    private readonly secretRef: string,
    private readonly storageKey: string,
    private readonly secrets: () => Promise<SecretsService>,
    private readonly slug: string,
    private readonly tokenEnv: string
  ) {}

  async resolveCurrent(secretRef: string) {
    const key = this.storageKeyFor(secretRef);
    if (key === null) return null;
    try {
      return { value: await (await this.secrets()).get(key) };
    } catch {
      // A missing personal secret is indistinguishable here from a missing business one, and both
      // mean the same thing to the lease: no credential. The *reason* a person has none is decided
      // upstream in `internal/credential-mode.ts`, which can prompt them to connect; failing open
      // to the business credential here would undo that decision silently.
      return null;
    }
  }

  private storageKeyFor(secretRef: string): string | null {
    if (secretRef === this.secretRef) return this.storageKey;
    const principal = principalOfRef(this.secretRef, secretRef);
    return principal === null ? null : principalSecretKey(principal, this.slug, this.tokenEnv);
  }
}

export interface DeclarativeToolingDeps {
  readonly businessId: string;
  readonly effects: EffectStore;
  readonly secrets: () => Promise<SecretsService>;
  /** Injected so tests never reach the network. */
  readonly http: EgressHttpPort;
}

interface CompiledIntegration {
  readonly slug: string;
  readonly tools: readonly CompiledEgressTool[];
  readonly credentialMode: ToolCredentialMode;
  /** Absent for a genuinely public API that declares no credential. */
  readonly credential?: {
    readonly ref: string;
    readonly storageKey: string;
    /** Carried so a personal lease can derive its own storage key from the same env name. */
    readonly tokenEnv: string;
  };
}

function compileIntegration(integration: SoulIntegration): CompiledIntegration {
  const { manifest, slug } = integration;
  const credentialMode = credentialModeFor(integration);
  if (manifest.egress?.type !== "openapi") return { slug, tools: [], credentialMode };

  // Connection env fills `{VAR}` placeholders in `base_url` — a per-install path segment such as
  // an Atlassian cloud id. Secret references are excluded: the credential has its own placement,
  // and a compiled binding is logged and inspected, so it must never hold one.
  const env = Object.fromEntries(
    Object.entries(integration.connection?.env ?? {}).filter(([, value]) => !isSecretRef(value))
  );
  const tools = compileOpenApiEgress({
    slug,
    egress: manifest.egress,
    document: integration.egressSpec,
    env,
  });
  const tokenEnv = manifest.egress.auth?.token_env;
  if (tokenEnv === undefined) return { slug, tools, credentialMode };
  return {
    slug,
    tools,
    credentialMode,
    credential: {
      ref: egressSecretRef(slug, tokenEnv),
      storageKey: integrationSecretKey(slug, tokenEnv),
      tokenEnv,
    },
  };
}

function buildToolDef(
  compiled: CompiledEgressTool,
  integration: CompiledIntegration,
  deps: DeclarativeToolingDeps,
  dispatcher: EffectDispatcher
): ToolDef {
  const { slug, credential, credentialMode } = integration;
  const toolName = declarativeToolName(slug, compiled.name);
  const action = compiled.contract.spec.action;

  const definition = defineApiTool<RequestContext>({
    name: toolName,
    tier: "integration",
    mutating: compiled.mutating,
    description: compiled.description,
    inputSchema: compiled.contract.spec.inputSchema,
    outputSchema: compiled.contract.spec.outputSchema,
    authorization: {
      action,
      resources: [integrationResource(slug)],
      targets: (args) => declarativeTargets(compiled, slug, args),
      dataClasses: compiled.contract.spec.dataClasses,
      allowedDestinations: compiled.contract.spec.allowedDestinations,
    },
    riskClass: compiled.contract.spec.riskClass,
    credentialMode,
    provider: slug,
    idempotency: compiled.contract.spec.idempotency.strategy,
    retry: compiled.contract.spec.retry,
    version: compiled.contract.spec.toolVersion,
    async handler(args, ctx): Promise<ToolCallResult> {
      const runId = ctx.runId;
      if (runId === undefined) return err("internal_error", "no run context for this tool call");
      const callId = ctx.toolCallId ?? crypto.randomUUID();
      const stateId = `invoke:${callId}`;
      const toolId = compiled.toolId;

      const intent = normalizeToolIntent({
        intentId: derivedId("egress-intent", runId, stateId, toolId),
        businessId: deps.businessId,
        runId,
        stateId,
        toolId,
        toolVersion: compiled.contract.spec.toolVersion,
        action,
        // The Tool's own declared derivation, not a second one written here: `targetsFor` is what
        // the gate reads, so building the intent from anything else would let the recorded effect
        // and the authorization decision describe different targets.
        targetRefs: definition.targetsFor(args, ctx),
        arguments: args,
        // Acting as a person means leasing *their* credential, not the deployment's. The ref is
        // part of the intent, so the recorded effect states plainly whose authority was spent.
        ...(credential === undefined
          ? {}
          : {
              credentialRef:
                ctx.credentialPrincipal === undefined
                  ? credential.ref
                  : principalEgressSecretRef(slug, credential.tokenEnv, ctx.credentialPrincipal),
            }),
        idempotencyKey: derivedId("egress-idempotency", runId, stateId, toolId),
      });

      const reserved = await deps.effects.reserve({
        effectId: derivedId("egress-effect", runId, stateId, toolId),
        businessId: deps.businessId,
        runId,
        stateId,
        logicalEffectOrdinal: 0,
        idempotencyKey: intent.idempotencyKey,
        intentDigest: intentDigest(intent),
        intent,
        guardrailRevision: ctx.guardrailRevision ?? "none",
        createdAt: new Date().toISOString(),
      });
      if (reserved.outcome === "duplicate") return replayed(reserved.effect.state);

      try {
        return ok(await dispatcher.dispatch(deps.businessId, reserved.effect.effectId));
      } catch (error) {
        if (error instanceof ToolDispatchError) return mapDispatchError(error, slug);
        throw error;
      }
    },
  });

  return toToolDef(definition, (ctx) => ctx);
}

function dispatcherFor(
  integration: CompiledIntegration,
  deps: DeclarativeToolingDeps
): EffectDispatcher {
  const catalog = ToolCatalog.load(integration.tools.map((tool) => tool.contract));
  const adapters = new Map<string, ToolAdapter>(
    integration.tools.map((tool) => [
      tool.adapterRef,
      new OpenApiToolAdapter({ binding: tool.binding, http: deps.http }),
    ])
  );

  const { credential } = integration;
  // Default-deny, scoped to this integration's own ref: a careless or hostile manifest can never
  // lease another integration's credential, let alone an unrelated platform secret.
  const authorizer: SecretAuthorizer = {
    authorize(scope) {
      if (
        credential === undefined ||
        (scope.secretRef !== credential.ref &&
          principalOfRef(credential.ref, scope.secretRef) === null)
      ) {
        return { allowed: false, reason: "not_authorized" };
      }
      return { allowed: true, maxTtlMs: 5 * 60 * 1000, maxUses: 1 };
    },
  };
  const credentials = new CredentialDispatcher({
    secrets: new SecretBroker({
      provider:
        credential === undefined
          ? { resolveCurrent: async () => null }
          : new EgressSecretProvider(
              credential.ref,
              credential.storageKey,
              deps.secrets,
              integration.slug,
              credential.tokenEnv
            ),
      authorizer,
    }),
    reauthorize: () => true,
  });

  return new EffectDispatcher({
    store: deps.effects,
    catalog,
    adapters,
    credentialDispatcher: credentials,
  });
}

export interface DeclarativeTooling {
  readonly tools: readonly ToolDef[];
  /** Why an integration published nothing, for the operator-facing log. */
  readonly problems: readonly string[];
}

/** Builds Tools only for connected integrations; malformed declarations report problems. */
export function buildDeclarativeTools(
  integrations: readonly SoulIntegration[],
  deps: DeclarativeToolingDeps,
  logger?: Logger
): DeclarativeTooling {
  const tools: ToolDef[] = [];
  const problems: string[] = [];
  const toolOwners = new Map<string, string>();

  for (const integration of integrations) {
    try {
      const compiled = compileIntegration(integration);
      if (compiled.tools.length === 0) continue;

      const dispatcher = dispatcherFor(compiled, deps);
      const built = compiled.tools.map((tool) => buildToolDef(tool, compiled, deps, dispatcher));
      for (const tool of built) {
        const owner = toolOwners.get(tool.name);
        if (owner !== undefined && owner !== integration.slug) {
          const problem = `Integration "${integration.slug}" skipped Tool "${tool.name}": tool name collides with integration "${owner}"`;
          problems.push(problem);
          logger?.error(problem);
          continue;
        }
        toolOwners.set(tool.name, integration.slug);
        tools.push(tool);
      }
    } catch (error) {
      const problem = `Integration "${integration.slug}" published no Tools: ${
        error instanceof Error ? error.message : String(error)
      }`;
      problems.push(problem);
      logger?.error(problem);
    }
  }

  return { tools, problems };
}
