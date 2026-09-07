import { createHash } from "node:crypto";
import {
  type CompiledEgressTool,
  type CompiledGraphqlTool,
  type CompiledOimGraphqlTool,
  type CompiledOimHttpTool,
  type CompiledOimOpenApiTool,
  compileGraphqlEgress,
  compileOimGraphqlOperations,
  compileOimHttpOperations,
  compileOimOpenApiOperations,
  compileOpenApiEgress,
  type EgressHttpPort,
  GraphqlToolAdapter,
  OIM_CONNECTION_ID_ARGUMENT,
  type OimFilePort,
  OimGraphqlToolAdapter,
  type OimHookPhaseRunner,
  OimHttpCompileError,
  OimHttpToolAdapter,
  type OimOperationConnection,
  type OimOperationConnectionResolver,
  type OimRateLimitAdmissionPort,
  OimRateLimitedToolAdapter,
  OpenApiToolAdapter,
  resolveOimBaseUrl,
  resolveOimUrlTemplate,
  runOimHookPhase,
} from "@tulipfarm/integrations";
import type { MutationGuard } from "@tulipfarm/observability";
import {
  canonicalHash,
  compileJsonSchema,
  type OimConnection,
  type OimHook,
  type OimManifest,
  type OimOperation,
  oimOriginPlaceholder,
} from "@tulipfarm/schema";
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
  AdapterDispatchError,
  CredentialDispatcher,
  EffectDispatcher,
  type EffectRetryParker,
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
import type { TrackConnectionBroker } from "../../integrations/connection-lease-registry";
import {
  type ConnectionOriginApprovalRepository,
  manifestForApprovedConnectionOrigin,
  oimConnectionOriginRequiresApproval,
} from "../../integrations/connection-origin-policy";
import {
  OimMajorLifecycleError,
  oimMajorStorageSlug,
  oimManifestMajor,
  oimPinnedToolId,
  requireOimConnectionForManifest,
  resolveOimMajorArtifact,
  resolveOimUnversionedAlias,
} from "../../integrations/oim-major-versions";
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
  | CompiledOimGraphqlTool
  | CompiledOimOpenApiTool;

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
  /** Reads exact operator-approved self-hosted origins from trusted persistence. */
  readonly originApprovals?: ConnectionOriginApprovalRepository;
  /** Tracks live brokers so Connection changes invalidate already-issued leases. */
  readonly trackConnectionBroker?: TrackConnectionBroker;
  readonly files?: OimFilePort;
  readonly rateLimits?: OimRateLimitAdmissionPort;
  readonly parkRetry?: EffectRetryParker;
  /** Verifies exact installed release provenance before an OIM operation can reserve an effect. */
  readonly authorizeOimIntegration?: (integration: SoulIntegration) => Promise<void>;
  /**
   * Runs only Hooks already authorized by `executeVerifiedOimHook`.
   *
   * The composition root owns release provenance and the sandbox. Keeping both behind this port
   * prevents declarative Tools from gaining a path to execute source directly.
   */
  readonly verifiedOimHooks?: {
    run(integration: SoulIntegration, hook: OimHook, input: unknown): Promise<unknown>;
  };
}

interface CompiledIntegration {
  readonly slug: string;
  readonly sourceIntegration: SoulIntegration;
  readonly toolAlias?: string;
  readonly oimManifest?: OimManifest;
  readonly oimDocuments?: Readonly<Record<string, string>>;
  readonly oimOpenApiDocuments?: Readonly<Record<string, unknown>>;
  readonly hookRunner?: OimHookPhaseRunner;
  readonly requestTargetsFor?: (arguments_: unknown) => readonly ToolTargetRef[];
  readonly tools: readonly CompiledDeclarativeTool[];
  readonly credentialMode: ToolCredentialMode;
  /** Every operation may name its own primary slot; legacy integrations contribute one entry. */
  readonly credentials: readonly {
    readonly ref: string;
    readonly storageKey: string;
    /** Carried so a personal lease can derive its own storage key from the same env name. */
    readonly tokenEnv: string;
  }[];
}

function compileOimIntegration(
  integration: SoulIntegration,
  credentialMode: ToolCredentialMode
): CompiledIntegration {
  const { oimManifest, slug } = integration;
  if (oimManifest === undefined) {
    return { slug, sourceIntegration: integration, tools: [], credentialMode, credentials: [] };
  }
  const tools = [
    ...compileOimHttpOperations(oimManifest, {}, { deferConfiguration: true }),
    ...compileOimOpenApiOperations(
      oimManifest,
      new Map(Object.entries(integration.oimOpenApiDocuments ?? {})),
      {},
      { deferConfiguration: true }
    ),
    ...compileOimGraphqlOperations(
      oimManifest,
      new Map(Object.entries(integration.oimDocuments ?? {})),
      {},
      { deferConfiguration: true }
    ),
  ];
  for (const tool of tools) {
    const pinnedToolId = oimPinnedToolId(oimManifest, tool.operation.id);
    if (tool.toolId !== pinnedToolId || tool.contract.spec.toolId !== pinnedToolId) {
      throw new Error(`OIM operation "${tool.operation.id}" has an unstable Tool identity`);
    }
  }
  const slots = new Set(
    oimManifest.operations
      .flatMap((operation) => [operation.credentialSlot, operation.secondaryCredential?.slot])
      .filter((slot): slot is string => slot !== undefined)
  );
  return {
    slug,
    sourceIntegration: integration,
    oimManifest,
    oimDocuments: integration.oimDocuments,
    oimOpenApiDocuments: integration.oimOpenApiDocuments,
    tools,
    credentialMode,
    credentials: [...slots].map((slot) => ({
      ref: oimSecretRef(slug, slot),
      storageKey: integrationSecretKey(slug, slot),
      tokenEnv: slot,
    })),
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
    return { slug, sourceIntegration: integration, tools: [], credentialMode, credentials: [] };
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
  if (tokenEnv === undefined) {
    return { slug, sourceIntegration: integration, tools, credentialMode, credentials: [] };
  }
  return {
    slug,
    sourceIntegration: integration,
    tools,
    credentialMode,
    credentials: [
      {
        ref: egressSecretRef(slug, tokenEnv),
        storageKey: integrationSecretKey(slug, tokenEnv),
        tokenEnv,
      },
    ],
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
      readonly kind: "configured";
      readonly configuration: Readonly<Record<string, string | number | boolean>>;
      readonly manifest: OimManifest;
    }
  | {
      readonly kind: "connection";
      readonly credentialRef: `secret://${string}`;
      readonly connection: ToolConnectionBinding;
      readonly configuration: Readonly<Record<string, string | number | boolean>>;
      readonly manifest: OimManifest;
      readonly secondaryCredentialRef?: `secret://${string}`;
      readonly secondaryConnection?: ToolConnectionBinding;
    }
  | { readonly kind: "answer"; readonly result: ToolCallResult };

function approvedOriginField(operation: OimOperation): string | undefined {
  const source = operation.source;
  if (source.type === "graphql") {
    return oimOriginPlaceholder(source.url);
  }
  if ((source.type !== "http" && source.type !== "openapi") || source.baseUrl === undefined) {
    return undefined;
  }
  return oimOriginPlaceholder(source.baseUrl);
}

async function manifestForOimConnection(
  deps: DeclarativeToolingDeps,
  manifest: OimManifest,
  operation: OimOperation,
  connection: OimConnection
): Promise<OimManifest> {
  const configurationField = approvedOriginField(operation);
  if (
    configurationField === undefined ||
    !oimConnectionOriginRequiresApproval(manifest, configurationField)
  ) {
    return manifest;
  }
  try {
    const source = operation.source;
    if (source.type === "graphql") {
      resolveOimUrlTemplate(manifest, operation, source.url, connection.configuration);
    } else {
      resolveOimBaseUrl(manifest, operation, connection.configuration);
    }
    return manifest;
  } catch (error) {
    if (!(error instanceof OimHttpCompileError) || error.code !== "origin_not_allowed") {
      throw error;
    }
  }
  const approval = await deps.originApprovals?.get(
    deps.businessId,
    connection.id,
    configurationField
  );
  if (approval === undefined || approval === null) {
    throw new Error("connection_origin_approval_missing");
  }
  return manifestForApprovedConnectionOrigin({ manifest, connection, approval });
}

async function resolveOimAuthority(
  compiled: CompiledDeclarativeTool,
  integration: CompiledIntegration,
  deps: DeclarativeToolingDeps,
  ctx: RequestContext,
  connectionId: string | undefined
): Promise<OimCallAuthority> {
  const { connections } = deps;
  const { oimManifest } = integration;
  if (oimManifest === undefined || !("operation" in compiled)) {
    return { kind: "proceed" };
  }
  if (connections === undefined) return { kind: "proceed" };
  const principal = ctx.subject ?? { kind: "user", id: ctx.userId };
  const resolution = await connections.resolve({
    businessId: deps.businessId,
    manifest: oimManifest,
    operation: compiled.operation,
    principal,
    // A user acting for themselves may reach their own personal Connection. Any other principal
    // gets only what it was granted, so it is never offered one it merely happens to know of.
    ...(principal.kind === "user" ? { personalOwnerId: principal.id } : {}),
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(ctx.routineContext === undefined || connectionId !== undefined
      ? {}
      : { requireExplicitConnection: true }),
  });
  if (resolution.kind === "public") return { kind: "proceed" };
  if (resolution.kind === "configured") {
    try {
      requireOimConnectionForManifest(resolution.connection, oimManifest);
    } catch {
      return {
        kind: "answer",
        result: ok(
          oimConnectionAnswer(
            { kind: "connection_denied", reason: "not_authorized" },
            integration.slug
          )
        ),
      };
    }
    try {
      const manifest = await manifestForOimConnection(
        deps,
        oimManifest,
        compiled.operation,
        resolution.connection
      );
      return {
        kind: "configured",
        configuration: resolution.connection.configuration,
        manifest,
      };
    } catch {
      return {
        kind: "answer",
        result: ok(
          oimConnectionAnswer(
            {
              kind: "connection_unhealthy",
              connectionId: resolution.connection.id,
              status: "action_required",
            },
            integration.slug
          )
        ),
      };
    }
  }
  if (resolution.kind === "ready") {
    try {
      requireOimConnectionForManifest(resolution.connection, oimManifest);
    } catch {
      return {
        kind: "answer",
        result: ok(
          oimConnectionAnswer(
            { kind: "connection_denied", reason: "not_authorized" },
            integration.slug
          )
        ),
      };
    }
    try {
      const manifest = await manifestForOimConnection(
        deps,
        oimManifest,
        compiled.operation,
        resolution.connection
      );
      return {
        kind: "connection",
        credentialRef: resolution.credentialRef,
        connection: resolution.binding,
        configuration: resolution.connection.configuration,
        manifest,
        ...(resolution.secondaryCredentialRef === undefined ||
        resolution.secondaryBinding === undefined
          ? {}
          : {
              secondaryCredentialRef: resolution.secondaryCredentialRef,
              secondaryConnection: resolution.secondaryBinding,
            }),
      };
    } catch {
      return {
        kind: "answer",
        result: ok(
          oimConnectionAnswer(
            {
              kind: "connection_unhealthy",
              connectionId: resolution.connection.id,
              status: "action_required",
            },
            integration.slug
          )
        ),
      };
    }
  }
  return { kind: "answer", result: ok(oimConnectionAnswer(resolution, integration.slug)) };
}

function withOimConnectionChoice(compiled: CompiledDeclarativeTool): Record<string, unknown> {
  const schema = compiled.contract.spec.inputSchema;
  if (!("operation" in compiled)) return schema;
  const properties =
    schema.properties !== null &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  return {
    ...schema,
    properties: {
      ...properties,
      [OIM_CONNECTION_ID_ARGUMENT]: {
        type: "string",
        minLength: 1,
        maxLength: 256,
        description: "Host-selected Connection id. Never sent to the provider.",
      },
    },
  };
}

function splitOimArguments(
  compiled: CompiledDeclarativeTool,
  args: unknown
): { readonly connectionId?: string; readonly providerArgs: unknown } {
  if (!("operation" in compiled)) return { providerArgs: args };
  const input = record(args);
  if (input === undefined) return { providerArgs: args };
  const { [OIM_CONNECTION_ID_ARGUMENT]: connectionId, ...providerArgs } = input;
  return {
    ...(typeof connectionId === "string" ? { connectionId } : {}),
    providerArgs,
  };
}

function compileOimToolForConfiguration(
  compiled: CompiledDeclarativeTool,
  integration: CompiledIntegration,
  configuration: Readonly<Record<string, string | number | boolean>>,
  approvedManifest?: OimManifest
): CompiledDeclarativeTool {
  const manifest = approvedManifest ?? integration.oimManifest;
  if (manifest === undefined || !("operation" in compiled)) return compiled;
  const one = { ...manifest, operations: [compiled.operation] };
  switch (compiled.operation.source.type) {
    case "http":
      return compileOimHttpOperations(one, configuration)[0] ?? compiled;
    case "openapi":
      return (
        compileOimOpenApiOperations(
          one,
          new Map(Object.entries(integration.oimOpenApiDocuments ?? {})),
          configuration
        )[0] ?? compiled
      );
    case "graphql":
      return (
        compileOimGraphqlOperations(
          one,
          new Map(Object.entries(integration.oimDocuments ?? {})),
          configuration
        )[0] ?? compiled
      );
  }
}

/** Turns an unresolved Connection into something the caller can act on, naming no credential. */
function oimConnectionAnswer(
  resolution: Exclude<OimOperationConnection, { readonly kind: "public" | "configured" | "ready" }>,
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

type OimInputHookResult =
  | { readonly kind: "arguments"; readonly arguments: unknown }
  | { readonly kind: "answer"; readonly result: ToolCallResult };

async function runOimInputValidation(
  compiled: CompiledDeclarativeTool,
  integration: CompiledIntegration,
  args: unknown
): Promise<OimInputHookResult> {
  const manifest = integration.oimManifest;
  if (manifest === undefined || !("operation" in compiled)) {
    return { kind: "arguments", arguments: args };
  }

  try {
    const validation = await runOimHookPhase({
      manifest,
      kind: "input_validate",
      input: { operationId: compiled.operation.id, arguments: args },
      ...(integration.hookRunner === undefined ? {} : { runner: integration.hookRunner }),
    });
    if (validation.executed) {
      const result = record(validation.value);
      if (result?.valid === false && typeof result.message === "string") {
        return { kind: "answer", result: err("validation_error", result.message.slice(0, 512)) };
      }
      if (result?.valid !== true) {
        return {
          kind: "answer",
          result: err("internal_error", "The input_validate Hook returned an invalid result."),
        };
      }
    }

    return { kind: "arguments", arguments: args };
  } catch {
    return {
      kind: "answer",
      result: err("internal_error", "The Integration Hook could not be executed safely."),
    };
  }
}

function buildToolDef(
  compiled: CompiledDeclarativeTool,
  integration: CompiledIntegration,
  deps: DeclarativeToolingDeps
): ToolDef {
  const { slug, credentialMode } = integration;
  const toolName = declarativeToolName(integration.toolAlias ?? slug, compiled.name);
  const action = compiled.contract.spec.action;

  const definition = defineApiTool<RequestContext>({
    name: toolName,
    tier: "integration",
    mutating: compiled.mutating,
    description: compiled.description,
    inputSchema: withOimConnectionChoice(compiled),
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

      if (integration.oimManifest !== undefined) {
        try {
          await deps.authorizeOimIntegration?.(integration.sourceIntegration);
        } catch {
          return err("internal_error", `${slug} is no longer approved for use.`);
        }
      }
      const { connectionId, providerArgs } = splitOimArguments(compiled, args);
      const authority = await resolveOimAuthority(compiled, integration, deps, ctx, connectionId);
      if (authority.kind === "answer") return authority.result;
      let runtimeCompiled: CompiledDeclarativeTool;
      const runtimeManifest =
        authority.kind === "connection" || authority.kind === "configured"
          ? authority.manifest
          : integration.oimManifest;
      try {
        runtimeCompiled =
          "operation" in compiled
            ? compileOimToolForConfiguration(
                compiled,
                integration,
                authority.kind === "connection" || authority.kind === "configured"
                  ? authority.configuration
                  : {},
                runtimeManifest
              )
            : compiled;
      } catch {
        return err(
          "internal_error",
          `${slug} Connection configuration is missing or no longer permitted.`
        );
      }
      // Keep the published manifest here so every retry must reload approval instead of treating
      // the exact host appended for this attempt as part of the package's static allowlist.
      const runtimeIntegration = {
        ...integration,
        tools: [runtimeCompiled],
        requestTargetsFor: (arguments_: unknown) => definition.targetsFor(arguments_, ctx),
      };
      const inputValidation = await runOimInputValidation(
        runtimeCompiled,
        runtimeIntegration,
        providerArgs
      );
      if (inputValidation.kind === "answer") return inputValidation.result;
      const runtimeArguments = inputValidation.arguments;
      const destination =
        authority.kind === "connection" || authority.kind === "configured"
          ? new URL(
              "baseUrl" in runtimeCompiled.binding
                ? runtimeCompiled.binding.baseUrl
                : runtimeCompiled.binding.url
            ).origin
          : undefined;
      const credential =
        "operation" in runtimeCompiled
          ? runtimeCompiled.operation.credentialSlot === undefined
            ? undefined
            : integration.credentials.find(
                (candidate) => candidate.tokenEnv === runtimeCompiled.operation.credentialSlot
              )
          : integration.credentials[0];

      const intent = normalizeToolIntent({
        intentId: derivedId("egress-intent", runId, stateId, toolId),
        businessId: deps.businessId,
        runId,
        stateId,
        toolId: runtimeCompiled.toolId,
        toolVersion: runtimeCompiled.contract.spec.toolVersion,
        action,
        // The Tool's own declared derivation, not a second one written here: `targetsFor` is what
        // the gate reads, so building the intent from anything else would let the recorded effect
        // and the authorization decision describe different targets.
        targetRefs: definition.targetsFor(runtimeArguments, ctx),
        arguments: runtimeArguments,
        ...("operation" in runtimeCompiled &&
        (runtimeCompiled.operation.response.mode === "binary" ||
          (runtimeCompiled.operation.source.type === "http" &&
            runtimeCompiled.operation.source.contentType === "multipart"))
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
              destination,
              ...(authority.secondaryCredentialRef === undefined ||
              authority.secondaryConnection === undefined
                ? {}
                : {
                    secondaryCredentialRef: authority.secondaryCredentialRef,
                    secondaryConnection: authority.secondaryConnection,
                  }),
            }
          : credential === undefined
            ? destination === undefined
              ? {}
              : { destination }
            : {
                credentialRef:
                  ctx.credentialPrincipal === undefined
                    ? credential.ref
                    : principalEgressSecretRef(slug, credential.tokenEnv, ctx.credentialPrincipal),
              }),
        idempotencyKey: derivedId("egress-idempotency", runId, stateId, runtimeCompiled.toolId),
      });

      const reserved = await deps.effects.reserve({
        effectId: derivedId("egress-effect", runId, stateId, runtimeCompiled.toolId),
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
      if (reserved.outcome === "duplicate" && reserved.effect.state !== "authorized") {
        return replayed(reserved.effect.state);
      }

      const activeDispatcher = dispatcherFor(runtimeIntegration, deps);
      try {
        return ok(
          await activeDispatcher.dispatcher.dispatch(
            deps.businessId,
            reserved.effect.effectId,
            ctx.abortSignal
          )
        );
      } catch (error) {
        if (error instanceof ToolDispatchError) return mapDispatchError(error, slug);
        throw error;
      } finally {
        activeDispatcher.releaseBroker?.();
      }
    },
  });

  const toolDef = toToolDef(definition, (ctx) => ctx);
  return integration.oimManifest === undefined
    ? toolDef
    : { ...toolDef, canonicalId: compiled.toolId };
}

class OimRequestShapingAdapter implements ToolAdapter {
  readonly kind;
  private readonly validateArguments: (value: unknown) => string | null;

  constructor(
    private readonly delegate: ToolAdapter,
    private readonly manifest: OimManifest,
    private readonly operationId: string,
    inputSchema: Record<string, unknown>,
    private readonly hookRunner: OimHookPhaseRunner | undefined,
    private readonly targetsFor: ((arguments_: unknown) => readonly ToolTargetRef[]) | undefined
  ) {
    this.kind = delegate.kind;
    this.validateArguments = compileJsonSchema(inputSchema);
  }

  async dispatch(
    request: Parameters<ToolAdapter["dispatch"]>[0],
    credential?: string,
    credentials?: Parameters<ToolAdapter["dispatch"]>[2]
  ): Promise<unknown> {
    try {
      const shaped = await runOimHookPhase({
        manifest: this.manifest,
        kind: "request_shape",
        input: { operationId: this.operationId, arguments: request.intent.arguments },
        ...(this.hookRunner === undefined ? {} : { runner: this.hookRunner }),
      });
      if (!shaped.executed) {
        return this.delegate.dispatch(request, credential, credentials);
      }
      if (record(shaped.value) === undefined || this.validateArguments(shaped.value) !== null) {
        throw new AdapterDispatchError("before_dispatch", "request_shape_hook_invalid", false);
      }
      if (
        this.targetsFor === undefined ||
        canonicalHash(this.targetsFor(shaped.value)) !== canonicalHash(request.intent.targetRefs)
      ) {
        throw new AdapterDispatchError("before_dispatch", "request_shape_target_mismatch", false);
      }
      return this.delegate.dispatch(
        {
          ...request,
          intent: { ...request.intent, arguments: shaped.value },
        },
        credential,
        credentials
      );
    } catch (error) {
      if (error instanceof AdapterDispatchError) throw error;
      throw new AdapterDispatchError("before_dispatch", "request_shape_hook_failed", false);
    }
  }
}

/**
 * Picks the adapter a compiled Tool's contract asks for, or `undefined` when this composition root
 * registers no implementation for that kind. Never falls back: the declared kind is the contract,
 * and guessing one is how a Tool reaches a backend nobody authorized.
 */
function adapterFor(
  tool: CompiledDeclarativeTool,
  deps: DeclarativeToolingDeps,
  integration: CompiledIntegration
): ToolAdapter | undefined {
  const manifest = integration.oimManifest;
  let adapter: ToolAdapter | undefined;
  switch (tool.contract.spec.adapter.kind) {
    case "openapi":
      if (!("pathTemplate" in tool.binding)) return undefined;
      adapter = new OpenApiToolAdapter({ binding: tool.binding, http: deps.http });
      break;
    case "graphql":
      if (!("document" in tool.binding)) return undefined;
      adapter =
        "operation" in tool && manifest !== undefined
          ? new OimGraphqlToolAdapter({
              binding: tool.binding,
              http: deps.http,
              manifest,
              ...(integration.hookRunner === undefined
                ? {}
                : { hookRunner: integration.hookRunner }),
              ...(tool.projection === undefined ? {} : { projection: tool.projection }),
            })
          : new GraphqlToolAdapter({ binding: tool.binding, http: deps.http });
      break;
    case "native":
      if (!("operation" in tool) || !("pathTemplate" in tool.binding)) return undefined;
      adapter = new OimHttpToolAdapter({
        binding: tool.binding,
        http: deps.http,
        ...(manifest === undefined ? {} : { manifest }),
        ...(integration.hookRunner === undefined ? {} : { hookRunner: integration.hookRunner }),
        toolId: tool.toolId,
        ...(tool.projection === undefined ? {} : { projection: tool.projection }),
        ...(deps.files === undefined ? {} : { files: deps.files }),
        ...("pagination" in tool && tool.pagination !== undefined
          ? { pagination: tool.pagination }
          : {}),
      });
      break;
    default:
      return undefined;
  }
  if (!("operation" in tool) || manifest === undefined) return adapter;
  const rateLimited =
    deps.rateLimits === undefined
      ? adapter
      : new OimRateLimitedToolAdapter({
          delegate: adapter,
          manifest,
          operation: tool.operation,
          limits: deps.rateLimits,
        });
  return new OimRequestShapingAdapter(
    rateLimited,
    manifest,
    tool.operation.id,
    tool.contract.spec.inputSchema,
    integration.hookRunner,
    integration.requestTargetsFor
  );
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
  const own = integration.credentials.map(
    (credential) =>
      new EgressSecretProvider(
        credential.ref,
        credential.storageKey,
        deps.secrets,
        integration.slug,
        credential.tokenEnv
      )
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
      if (ownsRef(secretRef)) {
        for (const provider of own) {
          const resolved = await provider.resolveCurrent(secretRef);
          if (resolved !== null) return resolved;
        }
        return null;
      }
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
): { readonly dispatcher: EffectDispatcher; readonly releaseBroker?: () => void } {
  const catalog = ToolCatalog.load(integration.tools.map((tool) => tool.contract));
  const adapters = new Map<string, ToolAdapter>();
  for (const tool of integration.tools) {
    const adapter = adapterFor(tool, deps, integration);
    // A kind with no implementation is left unregistered rather than handed the OpenAPI adapter:
    // the compiler emits the kind, so binding it to a backend it did not declare would let the
    // contract and the runtime disagree in silence. Dispatch then fails `adapter_not_found`,
    // which parks that one Tool instead of failing the whole integration's registration.
    if (adapter !== undefined) adapters.set(tool.adapterRef, adapter);
  }

  const integrationId = integration.oimManifest?.metadata.id;
  const ownsRef = (secretRef: string): boolean =>
    integration.credentials.some(
      (credential) =>
        secretRef === credential.ref || principalOfRef(credential.ref, secretRef) !== null
    );
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
  const secretBroker = new SecretBroker({
    provider: declarativeSecretProvider(integration, deps, ownsRef),
    authorizer,
  });
  const releaseBroker = deps.trackConnectionBroker?.(secretBroker);
  const credentials = new CredentialDispatcher({
    secrets: secretBroker,
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
      const runtimeTool = integration.tools.find(
        (candidate) => candidate.toolId === effect.intent.toolId
      );
      if (runtimeTool === undefined || !("operation" in runtimeTool)) return false;
      const currentConnection = await deps.connections.reauthorizeConnection(
        effect.businessId,
        integration.oimManifest,
        runtimeTool.operation,
        connection,
        credentialRef as `secret://${string}`
      );
      if (currentConnection === null) return false;
      let currentManifest: OimManifest;
      try {
        requireOimConnectionForManifest(currentConnection, integration.oimManifest);
        currentManifest = await manifestForOimConnection(
          deps,
          integration.oimManifest,
          runtimeTool.operation,
          currentConnection
        );
      } catch {
        return false;
      }
      let currentTool: CompiledDeclarativeTool;
      try {
        currentTool = compileOimToolForConfiguration(
          runtimeTool,
          integration,
          currentConnection.configuration,
          currentManifest
        );
      } catch {
        return false;
      }
      const currentDestination = new URL(
        "baseUrl" in currentTool.binding ? currentTool.binding.baseUrl : currentTool.binding.url
      ).origin;
      if (currentDestination !== effect.intent.destination) return false;
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

  return {
    dispatcher: new EffectDispatcher({
      store: deps.effects,
      catalog,
      adapters,
      credentialDispatcher: credentials,
      ...(deps.parkRetry === undefined ? {} : { parkRetry: deps.parkRetry }),
      ...(deps.mutationGuard === undefined
        ? {}
        : {
            mutationGuard: deps.mutationGuard,
            mutationIdentity: { integrationId: integration.slug },
          }),
    }),
    ...(releaseBroker === undefined ? {} : { releaseBroker }),
  };
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
      let toolAlias: string | undefined;
      if (integration.oimManifest !== undefined) {
        const integrationId = integration.oimManifest.metadata.id;
        const majorVersion = oimManifestMajor(integration.oimManifest);
        const exactArtifact = resolveOimMajorArtifact(integrations, {
          id: integrationId,
          majorVersion,
        });
        if (exactArtifact?.slug !== integration.slug) {
          throw new Error(
            `OIM Integration "${integrationId}" did not resolve to its exact major artifact`
          );
        }
        try {
          const unversioned = resolveOimUnversionedAlias(integrations, integrationId);
          if (unversioned?.slug !== integration.slug) {
            throw new Error(
              `OIM Integration alias "${integrationId}" did not resolve to its artifact`
            );
          }
          toolAlias = integrationId;
        } catch (error) {
          if (!(error instanceof OimMajorLifecycleError) || error.code !== "ambiguous_alias") {
            throw error;
          }
          toolAlias = oimMajorStorageSlug(integrationId, majorVersion);
        }
      }
      const base = compileIntegration(integration);
      const verifiedHooks = deps.verifiedOimHooks;
      const hookRunner =
        verifiedHooks === undefined
          ? undefined
          : {
              run: (hook: OimHook, input: unknown) => verifiedHooks.run(integration, hook, input),
            };
      const withAlias = toolAlias === undefined ? base : { ...base, toolAlias };
      const compiled = hookRunner === undefined ? withAlias : { ...withAlias, hookRunner };
      if (compiled.tools.length === 0) continue;

      const built = compiled.tools.map((tool) => buildToolDef(tool, compiled, deps));
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
