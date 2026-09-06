import { createHash } from "node:crypto";
import {
  type CompiledEgressTool,
  type CompiledGraphqlTool,
  type CompiledOimGraphqlTool,
  type CompiledOimHttpTool,
  compileGraphqlEgress,
  compileOimGraphqlOperations,
  compileOimHttpOperations,
  compileOpenApiEgress,
  type EgressHttpPort,
  GraphqlToolAdapter,
  type OimFilePort,
  OimHttpToolAdapter,
  type OimOperationConnection,
  type OimOperationConnectionResolver,
  OpenApiToolAdapter,
} from "@tulipfarm/integrations";
import type { MutationGuard } from "@tulipfarm/observability";
import type { OimManifest } from "@tulipfarm/schema";
import {
  type SecretAuthorizer,
  SecretBroker,
  type SecretProvider,
  type SecretsService,
  secretsServiceProvider,
} from "@tulipfarm/secrets";
import type { Logger, SoulIntegration } from "@tulipfarm/soul";
import { isPersonalCredentialStep, resolveAuthSteps } from "@tulipfarm/soul";
import {
  CredentialDispatcher,
  EffectDispatcher,
  type EffectRecord,
  type EffectStore,
  intentDigest,
  normalizeToolIntent,
  type ToolAdapter,
  ToolCatalog,
  type ToolConnectionBinding,
  type ToolCredentialMode,
  ToolDispatchError,
  type ToolTargetRef,
} from "@tulipfarm/tool-broker";
import {
  defineApiTool,
  err,
  ok,
  type RequestContext,
  type ToolCallResult,
  type ToolDef,
  toToolDef,
} from "@tulipfarm/tool-host";
import { integrationSecretKey, isSecretRef } from "../../integrations/connection-env";
import { principalSecretKey } from "../../integrations/principal-tokens";

/** Compiles manifest egress into governed chat Tools with the ledgered dispatch path. */

/** Tool names are namespaced by slug so two integrations may both publish `search`. */
export function declarativeToolName(slug: string, toolName: string): string {
  return `${definitionSlug(slug)}_${toolName}`;
}

/** The secret ref an OIM credential slot leases through. Slots are namespaced away from `egress`. */
export function oimSecretRef(slug: string, slot: string): string {
  return `secret://integrations/${slug}/oim/${slot}`;
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

/** Rediscovered confirmed effects return the first immutable provider result. */
function replayed(effect: EffectRecord): ToolCallResult {
  if (effect.state === "confirmed") {
    return effect.outputStored
      ? ok(effect.output)
      : err("internal_error", "confirmed_effect_output_unavailable");
  }
  return err("internal_error", `effect_${effect.state}`);
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
  const { oimManifest } = integration;
  if (oimManifest !== undefined) {
    // A manifest whose operations can act as the caller must prefer the caller's own Connection;
    // `shared_only` throughout means there is no personal identity to prefer.
    return oimManifest.operations.some((operation) => operation.identityMode !== "shared_only")
      ? "user_preferred"
      : "service";
  }
  if (integration.manifest === undefined) return "service";
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

type CompiledDeclarativeTool =
  | CompiledEgressTool
  | CompiledGraphqlTool
  | CompiledOimHttpTool
  | CompiledOimGraphqlTool;

function declarativeTargets(
  compiled: CompiledDeclarativeTool,
  slug: string,
  args: unknown
): readonly ToolTargetRef[] {
  const fields = new Set([
    ...("params" in compiled.binding ? compiled.binding.params.map((param) => param.name) : []),
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
  readonly mutationGuard?: MutationGuard;
  /**
   * Resolves which Connection an OIM operation acts through. Absent in deployments and tests that
   * publish no OIM manifest, in which case OIM Tools fall back to the single deployment-wide
   * Credential — the same path the older manifest families use.
   */
  readonly connections?: OimOperationConnectionResolver;
  readonly files?: OimFilePort;
}

interface CompiledIntegration {
  readonly slug: string;
  readonly oimManifest?: OimManifest;
  readonly tools: readonly CompiledDeclarativeTool[];
  readonly credentialMode: ToolCredentialMode;
  /** Absent for a genuinely public API that declares no credential. */
  readonly credential?: {
    readonly ref: string;
    readonly storageKey: string;
    /** Carried so a personal lease can derive its own storage key from the same env name. */
    readonly tokenEnv: string;
  };
}

function compileOimIntegration(
  integration: SoulIntegration,
  credentialMode: ToolCredentialMode
): CompiledIntegration {
  const { oimManifest, slug } = integration;
  if (oimManifest === undefined) return { slug, tools: [], credentialMode };
  // Non-secret Connection env resolves a templated base URL host — a customer's own Atlassian
  // site or GitLab instance. Secret refs are excluded: a compiled binding is logged and inspected.
  const configuration = Object.fromEntries(
    Object.entries(integration.connection?.env ?? {}).filter(([, value]) => !isSecretRef(value))
  );
  const tools = [
    ...compileOimHttpOperations(oimManifest, configuration),
    ...compileOimGraphqlOperations(
      oimManifest,
      new Map(Object.entries(integration.oimDocuments ?? {}))
    ),
  ];

  // Every operation's primary credential must name the same slot. A declared secondary credential
  // is resolved from that same Connection at call time, where both scoped leases are available.
  const slots = new Set(
    oimManifest.operations
      .map((operation) => operation.credentialSlot)
      .filter((slot): slot is string => slot !== undefined)
  );
  if (slots.size > 1) {
    throw new Error(
      `declares ${slots.size} credential slots (${[...slots].sort().join(", ")}); only one is supported`
    );
  }
  const [slot] = [...slots];
  if (slot === undefined) return { slug, oimManifest, tools, credentialMode };
  return {
    slug,
    oimManifest,
    tools,
    credentialMode,
    credential: {
      ref: oimSecretRef(slug, slot),
      storageKey: integrationSecretKey(slug, slot),
      tokenEnv: slot,
    },
  };
}

function compileIntegration(integration: SoulIntegration): CompiledIntegration {
  const { manifest, slug } = integration;
  const credentialMode = credentialModeFor(integration);
  if (integration.oimManifest !== undefined) {
    return compileOimIntegration(integration, credentialMode);
  }
  // Callers filter out manifest-less (bundled) integrations before reaching here.
  if (
    manifest === undefined ||
    (manifest.egress?.type !== "openapi" && manifest.egress?.type !== "graphql")
  ) {
    return { slug, tools: [], credentialMode };
  }

  // Connection env fills `{VAR}` placeholders in `base_url` — a per-install path segment such as
  // an Atlassian cloud id. Secret references are excluded: the credential has its own placement,
  // and a compiled binding is logged and inspected, so it must never hold one.
  const env = Object.fromEntries(
    Object.entries(integration.connection?.env ?? {}).filter(([, value]) => !isSecretRef(value))
  );
  const tools =
    manifest.egress.type === "openapi"
      ? compileOpenApiEgress({
          slug,
          egress: manifest.egress,
          document: integration.egressSpec,
          env,
        })
      : compileGraphqlEgress({ slug, egress: manifest.egress });
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

/**
 * The authority an OIM operation acts with, or the answer to give the caller instead of dispatching.
 *
 * Connection resolution happens before the effect is reserved. Reserving first would record an
 * intent whose credential was never resolved, and the outcomes below are ordinary answers a person
 * or an Agent has to act on — pick a Connection, connect one, re-authorize a stale one — rather
 * than failures of the call.
 */
type OimCallAuthority =
  | { readonly kind: "proceed" }
  | {
      readonly kind: "connection";
      readonly credentialRef: `secret://${string}`;
      readonly connection: ToolConnectionBinding;
      readonly destination: string;
      readonly secondaryCredentialRef?: `secret://${string}`;
      readonly secondaryConnection?: ToolConnectionBinding;
    }
  | { readonly kind: "answer"; readonly result: ToolCallResult };

async function resolveOimAuthority(
  compiled: CompiledDeclarativeTool,
  integration: CompiledIntegration,
  deps: DeclarativeToolingDeps,
  ctx: RequestContext
): Promise<OimCallAuthority> {
  const { connections } = deps;
  const { oimManifest } = integration;
  if (connections === undefined || oimManifest === undefined || !("operation" in compiled)) {
    return { kind: "proceed" };
  }
  const principal = ctx.subject ?? { kind: "user", id: ctx.userId };
  const resolution = await connections.resolve({
    businessId: deps.businessId,
    manifest: oimManifest,
    operation: compiled.operation,
    principal,
    // A user acting for themselves may reach their own personal Connection. Any other principal
    // gets only what it was granted, so it is never offered one it merely happens to know of.
    ...(principal.kind === "user" ? { personalOwnerId: principal.id } : {}),
  });
  if (resolution.kind === "public") return { kind: "proceed" };
  if (resolution.kind === "ready") {
    return {
      kind: "connection",
      credentialRef: resolution.credentialRef,
      connection: resolution.binding,
      destination: new URL(
        "baseUrl" in compiled.binding ? compiled.binding.baseUrl : compiled.binding.url
      ).origin,
      ...(resolution.secondaryCredentialRef === undefined ||
      resolution.secondaryBinding === undefined
        ? {}
        : {
            secondaryCredentialRef: resolution.secondaryCredentialRef,
            secondaryConnection: resolution.secondaryBinding,
          }),
    };
  }
  return { kind: "answer", result: ok(oimConnectionAnswer(resolution, integration.slug)) };
}

/** Turns an unresolved Connection into something the caller can act on, naming no credential. */
function oimConnectionAnswer(
  resolution: Exclude<OimOperationConnection, { readonly kind: "public" | "ready" }>,
  slug: string
): Record<string, unknown> {
  const setupUrl = `/business/integrations/${encodeURIComponent(slug)}/connections`;
  switch (resolution.kind) {
    case "connection_required":
    case "connection_ambiguous":
      return {
        kind: resolution.kind,
        requiredAction: resolution.candidates.length === 0 ? "connect" : "select_connection",
        // Only the Agent-visible configuration the resolver already filtered to. A candidate list
        // is shown to choose from, so it must not become a way to read a Connection's private
        // settings.
        candidates: resolution.candidates,
        setupUrl,
        detail:
          resolution.candidates.length === 0
            ? `no Connection for "${slug}" is available to you; one must be connected first`
            : `more than one Connection for "${slug}" could apply; a person must choose which one this acts through`,
      };
    case "connection_unhealthy":
      return {
        kind: resolution.kind,
        requiredAction: "reconnect",
        connectionId: resolution.connectionId,
        status: resolution.status,
        setupUrl,
        detail: `this Connection is ${resolution.status} and must be reconnected before it can be used`,
      };
    case "credential_required":
      return {
        kind: resolution.kind,
        connectionId: resolution.connectionId,
        credentialSlot: resolution.credentialSlot,
        setupUrl,
        detail: `this Connection has no Credential for "${resolution.credentialSlot}"`,
      };
    default:
      return {
        kind: resolution.kind,
        reason: resolution.reason,
        setupUrl,
        detail: `this Connection cannot be used here (${resolution.reason})`,
      };
  }
}

function buildToolDef(
  compiled: CompiledDeclarativeTool,
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

      const authority = await resolveOimAuthority(compiled, integration, deps, ctx);
      if (authority.kind === "answer") return authority.result;

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
        ...("operation" in compiled &&
        compiled.operation.source.type === "http" &&
        (compiled.operation.source.contentType === "multipart" ||
          compiled.operation.response.mode === "binary")
          ? { filePrincipalId: ctx.userId }
          : {}),
        // Acting as a person means leasing *their* credential, not the deployment's. The ref is
        // part of the intent, so the recorded effect states plainly whose authority was spent.
        // A resolved Connection supersedes the deployment-wide Credential: it names the exact
        // Connection, slot and principal the effect was authorized against, so an Approval binds
        // to that rather than to "whatever this integration's one Credential is today".
        ...(authority.kind === "connection"
          ? {
              credentialRef: authority.credentialRef,
              connection: authority.connection,
              destination: authority.destination,
              ...(authority.secondaryCredentialRef === undefined ||
              authority.secondaryConnection === undefined
                ? {}
                : {
                    secondaryCredentialRef: authority.secondaryCredentialRef,
                    secondaryConnection: authority.secondaryConnection,
                  }),
            }
          : credential === undefined
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
      if (reserved.outcome === "duplicate") return replayed(reserved.effect);

      try {
        return ok(
          await dispatcher.dispatch(deps.businessId, reserved.effect.effectId, ctx.abortSignal)
        );
      } catch (error) {
        if (error instanceof ToolDispatchError) return mapDispatchError(error, slug);
        throw error;
      }
    },
  });

  return toToolDef(definition, (ctx) => ctx);
}

/**
 * Picks the adapter a compiled Tool's contract asks for, or `undefined` when this composition root
 * registers no implementation for that kind. Never falls back: the declared kind is the contract,
 * and guessing one is how a Tool reaches a backend nobody authorized.
 */
function adapterFor(
  tool: CompiledDeclarativeTool,
  deps: DeclarativeToolingDeps
): ToolAdapter | undefined {
  switch (tool.contract.spec.adapter.kind) {
    case "openapi":
      if (!("pathTemplate" in tool.binding)) return undefined;
      return new OpenApiToolAdapter({ binding: tool.binding, http: deps.http });
    case "graphql":
      if (!("document" in tool.binding)) return undefined;
      return new GraphqlToolAdapter({ binding: tool.binding, http: deps.http });
    case "native":
      if (!("operation" in tool) || !("pathTemplate" in tool.binding)) return undefined;
      return new OimHttpToolAdapter({
        binding: tool.binding,
        http: deps.http,
        toolId: tool.toolId,
        ...(tool.projection === undefined ? {} : { projection: tool.projection }),
        ...(deps.files === undefined ? {} : { files: deps.files }),
        ...("pagination" in tool && tool.pagination !== undefined
          ? { pagination: tool.pagination }
          : {}),
      });
    default:
      return undefined;
  }
}

/**
 * Serves this integration's own Credential and, separately, whichever Connection Secret a call
 * resolved.
 *
 * The two are kept apart rather than merged into one lookup: the integration's ref is fixed at
 * compile time and can be checked against, while a Connection ref is chosen per call. Routing an
 * unrecognised ref to the Connection reader — instead of falling back to the integration's own
 * Credential — is what stops a denied Connection quietly borrowing the deployment's key.
 */
function declarativeSecretProvider(
  integration: CompiledIntegration,
  deps: DeclarativeToolingDeps,
  ownsRef: (secretRef: string) => boolean
): SecretProvider {
  const { credential } = integration;
  const own =
    credential === undefined
      ? undefined
      : new EgressSecretProvider(
          credential.ref,
          credential.storageKey,
          deps.secrets,
          integration.slug,
          credential.tokenEnv
        );
  const connections =
    deps.connections === undefined
      ? undefined
      : secretsServiceProvider({
          resolveCurrent: async (key) => (await deps.secrets()).resolveCurrent(key),
          revision: async (key) => (await deps.secrets()).revision(key),
        });
  // A Connection ref that is not a valid opaque id denies the lease rather than raising: the
  // Connection store is the only writer of these, so a malformed one is corruption, and reporting
  // it as an internal error would tell the caller the Tool is broken instead of the Connection.
  const failClosed = async <T>(
    read: () => Promise<T | null | undefined> | undefined
  ): Promise<T | null> => {
    try {
      return (await read()) ?? null;
    } catch {
      return null;
    }
  };
  return {
    async resolveCurrent(secretRef) {
      if (ownsRef(secretRef)) return (await own?.resolveCurrent(secretRef)) ?? null;
      return failClosed(() => connections?.resolveCurrent(secretRef));
    },
    async currentVersion(secretRef) {
      // The integration's own Credential carries no durable revision, so a Connection lease — which
      // requires one — can never be satisfied by it.
      if (ownsRef(secretRef)) return null;
      return failClosed(() => connections?.currentVersion?.(secretRef));
    },
  };
}

function dispatcherFor(
  integration: CompiledIntegration,
  deps: DeclarativeToolingDeps
): EffectDispatcher {
  const catalog = ToolCatalog.load(integration.tools.map((tool) => tool.contract));
  const adapters = new Map<string, ToolAdapter>();
  for (const tool of integration.tools) {
    const adapter = adapterFor(tool, deps);
    // A kind with no implementation is left unregistered rather than handed the OpenAPI adapter:
    // the compiler emits the kind, so binding it to a backend it did not declare would let the
    // contract and the runtime disagree in silence. Dispatch then fails `adapter_not_found`,
    // which parks that one Tool instead of failing the whole integration's registration.
    if (adapter !== undefined) adapters.set(tool.adapterRef, adapter);
  }

  const { credential } = integration;
  const integrationId = integration.oimManifest?.metadata.id;
  const ownsRef = (secretRef: string): boolean =>
    credential !== undefined &&
    (secretRef === credential.ref || principalOfRef(credential.ref, secretRef) !== null);
  // Default-deny, scoped to this integration's own ref: a careless or hostile manifest can never
  // lease another integration's credential, let alone an unrelated platform secret. A Connection
  // ref is admitted on different evidence — the scope must name the Connection this integration's
  // own resolver selected — because the ref is chosen per call and is not knowable from here.
  const authorizer: SecretAuthorizer = {
    authorize(scope) {
      if (ownsRef(scope.secretRef)) {
        return { allowed: true, maxTtlMs: 5 * 60 * 1000, maxUses: 1 };
      }
      const connectionScope = scope as { connectionId?: string; integrationId?: string };
      if (
        integrationId !== undefined &&
        connectionScope.connectionId !== undefined &&
        connectionScope.integrationId === integrationId
      ) {
        return { allowed: true, maxTtlMs: 5 * 60 * 1000, maxUses: 1 };
      }
      return { allowed: false, reason: "not_authorized" };
    },
  };
  const credentials = new CredentialDispatcher({
    secrets: new SecretBroker({
      provider: declarativeSecretProvider(integration, deps, ownsRef),
      authorizer,
    }),
    reauthorize: async (effect) => {
      const connection = effect.intent.connection;
      const credentialRef = effect.intent.credentialRef;
      if (
        connection === undefined ||
        credentialRef === undefined ||
        integration.oimManifest === undefined ||
        deps.connections === undefined
      ) {
        return connection === undefined;
      }
      if (
        !(await deps.connections.reauthorize(
          effect.businessId,
          integration.oimManifest,
          connection,
          credentialRef as `secret://${string}`
        ))
      ) {
        return false;
      }
      const secondaryConnection = effect.intent.secondaryConnection;
      const secondaryCredentialRef = effect.intent.secondaryCredentialRef;
      return (
        (secondaryConnection === undefined && secondaryCredentialRef === undefined) ||
        (secondaryConnection !== undefined &&
          secondaryCredentialRef !== undefined &&
          (await deps.connections.reauthorize(
            effect.businessId,
            integration.oimManifest,
            secondaryConnection,
            secondaryCredentialRef as `secret://${string}`
          )))
      );
    },
  });

  return new EffectDispatcher({
    store: deps.effects,
    catalog,
    adapters,
    credentialDispatcher: credentials,
    ...(deps.mutationGuard === undefined
      ? {}
      : {
          mutationGuard: deps.mutationGuard,
          mutationIdentity: { integrationId: integration.slug },
        }),
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
    // No manifest of either kind means a bundled, code-owned integration (Soul holds only
    // connection state); its Tools are handwritten, not declarative.
    if (integration.manifest === undefined && integration.oimManifest === undefined) continue;
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
