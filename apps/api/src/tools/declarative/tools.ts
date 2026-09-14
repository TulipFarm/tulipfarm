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
  extractOimMultipartFileIds,
  GraphqlToolAdapter,
  OIM_CONNECTION_ID_ARGUMENT,
  type OimFilePort,
  type OimFileReadAuthorizationPort,
  OimGraphqlToolAdapter,
  OimHttpToolAdapter,
  type OimOperationConnection,
  type OimOperationConnectionResolver,
  type OimPaginationRuntime,
  OpenApiToolAdapter,
  oimManifestMajor,
} from "@tulipfarm/integrations";
import type { MutationGuard } from "@tulipfarm/observability";
import { canonicalHash, type OimManifest, type OimOperation } from "@tulipfarm/schema";
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
  EffectDispatchDeferredError,
  EffectDispatcher,
  type EffectRecord,
  type EffectRetryParker,
  type EffectRetryWaitReader,
  type EffectStore,
  intentDigest,
  normalizeToolIntent,
  type ToolAdapter,
  ToolCatalog,
  type ToolConnectionBinding,
  type ToolCredentialMode,
  ToolDispatchError,
  type ToolIntent,
  type ToolTargetRef,
} from "@tulipfarm/tool-broker";
import {
  defineParkableApiTool,
  err,
  ok,
  type ParkableToolCallResult,
  type ParkableToolDef,
  parked,
  type RequestContext,
  type ToolCallPreparationPort,
  type ToolCallResult,
  ToolPreparationDeniedError,
  toToolDef,
} from "@tulipfarm/tool-host";
import { integrationSecretKey, isSecretRef } from "../../integrations/connection-env";
import { principalSecretKey } from "../../integrations/principal-tokens";
import type {
  OimDispatchSettlement,
  OimProviderDispatch,
  OimReleaseDispatchPort,
} from "../../integrations/releases/dispatch-host";

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
  if (integration.oimManifest !== undefined) {
    return integration.oimManifest.operations.some(
      (operation) => operation.identityMode !== "shared_only"
    )
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
  | CompiledOimOpenApiTool
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
  readonly connections?: OimOperationConnectionResolver;
  readonly files?: OimFilePort;
  readonly fileReadAuthorization?: OimFileReadAuthorizationPort;
  readonly paginationRuntime?: OimPaginationRuntime;
  readonly parkRetry?: EffectRetryParker;
  readonly retryWaitStatus?: EffectRetryWaitReader;
  readonly releaseDispatch?: OimReleaseDispatchPort;
  /** Initial caller + Agent File authority check, before approval or effect reservation. */
  readonly authorizeFiles?: (input: {
    businessId: string;
    runId: string;
    stateId: string;
    caller: { readonly kind: string; readonly id: string };
    agentPrincipalId?: string;
    fileIds: readonly string[];
  }) => Promise<void>;
}

interface CompiledIntegration {
  readonly slug: string;
  readonly tools: readonly CompiledDeclarativeTool[];
  readonly credentialMode: ToolCredentialMode;
  readonly oimManifest?: OimManifest;
  readonly oimDocuments?: Readonly<Record<string, string>>;
  readonly oimOpenApiDocuments?: Readonly<Record<string, unknown>>;
  readonly oimPackageFiles?: SoulIntegration["oimPackageFiles"];
  /** Absent for a genuinely public API that declares no credential. */
  readonly credential?: {
    readonly ref: string;
    readonly storageKey: string;
    /** Carried so a personal lease can derive its own storage key from the same env name. */
    readonly tokenEnv: string;
  };
}

function compileIntegration(integration: SoulIntegration): CompiledIntegration {
  const { manifest, oimManifest, slug } = integration;
  const credentialMode = credentialModeFor(integration);
  if (oimManifest !== undefined) {
    return {
      slug,
      credentialMode,
      oimManifest,
      oimDocuments: integration.oimDocuments,
      oimOpenApiDocuments: integration.oimOpenApiDocuments,
      oimPackageFiles: integration.oimPackageFiles,
      tools: [
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
      ],
    };
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

function splitOimArguments(args: unknown): {
  readonly connectionId?: string;
  readonly providerArguments: unknown;
} {
  const input = record(args);
  if (input === undefined) return { providerArguments: args };
  const { [OIM_CONNECTION_ID_ARGUMENT]: connectionId, ...providerArguments } = input;
  return {
    ...(typeof connectionId === "string" ? { connectionId } : {}),
    providerArguments,
  };
}

function withOimConnectionChoice(compiled: CompiledDeclarativeTool): Record<string, unknown> {
  const schema = compiled.contract.spec.inputSchema;
  if (!("operation" in compiled)) return schema;
  const properties = record(schema.properties) ?? {};
  return {
    ...schema,
    properties: {
      ...properties,
      [OIM_CONNECTION_ID_ARGUMENT]: {
        type: "string",
        minLength: 1,
        maxLength: 256,
        description: "Connection to use. The host removes this before provider dispatch.",
      },
    },
  };
}

function compileOimRuntimeTool(
  compiled: CompiledDeclarativeTool,
  integration: CompiledIntegration,
  configuration: Readonly<Record<string, string | number | boolean>>
): CompiledDeclarativeTool {
  const manifest = integration.oimManifest;
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

function oimDestination(compiled: CompiledDeclarativeTool): string | undefined {
  if (!("operation" in compiled)) return undefined;
  return new URL("baseUrl" in compiled.binding ? compiled.binding.baseUrl : compiled.binding.url)
    .origin;
}

function configuredBinding(
  manifest: OimManifest,
  operation: OimOperation,
  connection: Extract<OimOperationConnection, { kind: "configured" }>["connection"],
  principal: { readonly kind: string; readonly id: string }
): ToolConnectionBinding {
  return {
    connectionId: connection.id,
    integrationId: manifest.metadata.id,
    integrationMajorVersion: oimManifestMajor(manifest),
    operationId: operation.id,
    identityMode: operation.identityMode,
    principalKind: principal.kind,
    principalId: principal.id,
    manifestDigest: canonicalHash(manifest),
    configurationDigest: canonicalHash(connection.configuration),
  };
}

function oimConnectionDenial(resolution: OimOperationConnection, slug: string): never {
  const connectUrl = `/business/integrations/${encodeURIComponent(slug)}/connections`;
  switch (resolution.kind) {
    case "connection_required":
    case "connection_ambiguous":
      throw new ToolPreparationDeniedError(
        resolution.candidates.length === 0
          ? `No usable Connection exists for "${slug}". Connect one first.`
          : `More than one Connection can run "${slug}". Choose one with connection_id.`,
        connectUrl
      );
    case "connection_unhealthy":
      throw new ToolPreparationDeniedError(
        `Connection "${resolution.connectionId}" is ${resolution.status} and must be reconnected.`,
        connectUrl
      );
    case "credential_required":
      throw new ToolPreparationDeniedError(
        `Connection "${resolution.connectionId}" is missing Credential "${resolution.credentialSlot}".`,
        connectUrl
      );
    case "connection_denied":
      throw new ToolPreparationDeniedError(
        `The selected Connection cannot be used here (${resolution.reason}).`,
        connectUrl
      );
    default:
      throw new ToolPreparationDeniedError(`Could not resolve a safe Connection for "${slug}".`);
  }
}

type OimPreparer = ToolCallPreparationPort["prepare"];
type OimConfirmedReplayer = NonNullable<ToolCallPreparationPort["replayConfirmed"]>;

function oimConfirmedReplayer(
  compiled: CompiledDeclarativeTool,
  deps: DeclarativeToolingDeps
): OimConfirmedReplayer {
  return async (input) => {
    if (!("operation" in compiled)) return undefined;
    const effectId = derivedId(
      "egress-effect",
      input.runId,
      `chat:${input.toolCallId}`,
      compiled.toolId
    );
    const effect = await deps.effects.get(input.businessId, effectId);
    if (effect === undefined) return undefined;
    const deny = (reason: string) => ({ outcome: "denied" as const, reason });
    if (effect.state === "ambiguous" || effect.state === "reconciliation_required") {
      return deny(`tool "${input.tool.name}" requires effect reconciliation`);
    }
    if (effect.state !== "confirmed") return undefined;
    const reconcile = async (reason: string) => {
      await deps.effects.transition({
        businessId: effect.businessId,
        effectId: effect.effectId,
        expectedStates: ["confirmed", "reconciliation_required"],
        state: "reconciliation_required",
        updatedAt: new Date().toISOString(),
      });
      return deny(reason);
    };
    if (!effect.outputStored) {
      return await reconcile(
        `tool "${input.tool.name}" already completed, but its output is unavailable`
      );
    }

    let intent: ToolIntent;
    try {
      intent = normalizeToolIntent(effect.intent);
    } catch {
      return await reconcile(`tool "${input.tool.name}" has invalid durable replay evidence`);
    }
    const storedCallId = effect.stateId.startsWith("chat:")
      ? effect.stateId.slice("chat:".length)
      : undefined;
    if (
      storedCallId === undefined ||
      storedCallId.length === 0 ||
      intentDigest(intent) !== effect.intentDigest ||
      intent.businessId !== effect.businessId ||
      intent.runId !== effect.runId ||
      intent.stateId !== effect.stateId ||
      intent.idempotencyKey !== effect.idempotencyKey ||
      intent.intentId !== derivedId("egress-intent", effect.runId, storedCallId, intent.toolId) ||
      effect.idempotencyKey !==
        derivedId("egress-idempotency", effect.runId, storedCallId, intent.toolId) ||
      effect.effectId !== derivedId("egress-effect", effect.runId, effect.stateId, intent.toolId)
    ) {
      return await reconcile(`tool "${input.tool.name}" has invalid durable replay evidence`);
    }
    const { connectionId, providerArguments } = splitOimArguments(input.arguments);
    const expectedStateId = `chat:${input.toolCallId}`;
    const expectedIntentId = derivedId(
      "egress-intent",
      input.runId,
      input.toolCallId,
      compiled.toolId
    );
    const expectedIdempotencyKey = derivedId(
      "egress-idempotency",
      input.runId,
      input.toolCallId,
      compiled.toolId
    );
    if (
      input.pinnedIntent === undefined ||
      intentDigest(input.pinnedIntent) !== effect.intentDigest ||
      effect.businessId !== input.businessId ||
      effect.runId !== input.runId ||
      effect.stateId !== expectedStateId ||
      effect.idempotencyKey !== expectedIdempotencyKey ||
      intent.intentId !== expectedIntentId ||
      intent.businessId !== input.businessId ||
      intent.runId !== input.runId ||
      intent.stateId !== expectedStateId ||
      intent.runStateId !== input.stateId ||
      intent.toolId !== compiled.toolId ||
      intent.toolVersion !== compiled.contract.spec.toolVersion ||
      intent.action !== compiled.contract.spec.action ||
      intent.idempotencyKey !== expectedIdempotencyKey ||
      canonicalHash(intent.arguments) !== canonicalHash(providerArguments) ||
      intent.principalKind !== input.subject.kind ||
      intent.principalId !== input.subject.id ||
      intent.agentPrincipalId !== input.agent.principalId ||
      intent.activeSkillName !== input.activeSkillName ||
      (connectionId !== undefined && connectionId !== intent.connection?.connectionId)
    ) {
      return deny(`tool "${input.tool.name}" confirmed replay binding does not match this call`);
    }
    return { outcome: "confirmed", output: effect.output };
  };
}

function oimPreparer(
  compiled: CompiledDeclarativeTool,
  integration: CompiledIntegration,
  deps: DeclarativeToolingDeps,
  definition: NonNullable<ParkableToolDef["definition"]>
): OimPreparer {
  return async (input) => {
    const manifest = integration.oimManifest;
    if (manifest === undefined || !("operation" in compiled) || deps.connections === undefined) {
      return undefined;
    }
    const { connectionId: requestedConnectionId, providerArguments } = splitOimArguments(
      input.arguments
    );
    const pinnedConnectionId = input.pinnedIntent?.connection?.connectionId;
    if (
      pinnedConnectionId !== undefined &&
      requestedConnectionId !== undefined &&
      requestedConnectionId !== pinnedConnectionId
    ) {
      throw new ToolPreparationDeniedError("The approved Connection binding no longer matches.");
    }
    const principal = input.subject;
    const resolution = await deps.connections.resolve({
      businessId: input.businessId,
      manifest,
      operation: compiled.operation,
      principal,
      ...(principal.kind === "user" ? { personalOwnerId: principal.id } : {}),
      ...((pinnedConnectionId ?? requestedConnectionId) === undefined
        ? {}
        : { connectionId: pinnedConnectionId ?? requestedConnectionId }),
    });
    if (
      resolution.kind !== "public" &&
      resolution.kind !== "configured" &&
      resolution.kind !== "ready"
    ) {
      return oimConnectionDenial(resolution, integration.slug);
    }

    const configuration = resolution.kind === "public" ? {} : resolution.connection.configuration;
    let runtime: CompiledDeclarativeTool;
    try {
      runtime = compileOimRuntimeTool(compiled, integration, configuration);
    } catch {
      throw new ToolPreparationDeniedError(
        `The selected "${integration.slug}" Connection configuration is not permitted.`
      );
    }
    if (
      "pagination" in runtime &&
      runtime.pagination !== undefined &&
      deps.paginationRuntime === undefined
    ) {
      throw new ToolPreparationDeniedError(
        "Secure continuation storage is not configured for this paginated Tool."
      );
    }
    const destination = oimDestination(runtime);
    const fileIds =
      "multipart" in runtime.binding
        ? extractOimMultipartFileIds(runtime.binding, providerArguments)
        : [];
    const producesBinaryFile =
      "binaryResponse" in runtime.binding && runtime.binding.binaryResponse === true;
    if (fileIds.length > 0) {
      if (deps.authorizeFiles === undefined) {
        throw new ToolPreparationDeniedError("File access cannot be authorized by this host.");
      }
      await deps.authorizeFiles({
        businessId: input.businessId,
        runId: input.runId,
        stateId: input.stateId,
        caller: principal,
        ...(input.agent.principalId === undefined
          ? {}
          : { agentPrincipalId: input.agent.principalId }),
        fileIds,
      });
    }

    let connection: ToolConnectionBinding | undefined;
    let credentialRef: `secret://${string}` | undefined;
    let secondaryConnection: ToolConnectionBinding | undefined;
    let secondaryCredentialRef: `secret://${string}` | undefined;
    if (resolution.kind === "configured") {
      connection = configuredBinding(
        manifest,
        compiled.operation,
        resolution.connection,
        principal
      );
    } else if (resolution.kind === "ready") {
      const provider = secretsServiceProvider(await deps.secrets());
      const revision = await provider.currentVersion?.(resolution.credentialRef);
      if (revision == null) {
        throw new ToolPreparationDeniedError("The selected Connection Credential was revoked.");
      }
      connection = { ...resolution.binding, credentialRevision: revision };
      credentialRef = resolution.credentialRef;
      if (
        resolution.secondaryBinding !== undefined &&
        resolution.secondaryCredentialRef !== undefined
      ) {
        const secondaryRevision = await provider.currentVersion?.(
          resolution.secondaryCredentialRef
        );
        if (secondaryRevision == null) {
          throw new ToolPreparationDeniedError(
            "The selected Connection secondary Credential was revoked."
          );
        }
        secondaryConnection = {
          ...resolution.secondaryBinding,
          credentialRevision: secondaryRevision,
        };
        secondaryCredentialRef = resolution.secondaryCredentialRef;
      }
    }

    const targetRefs = [
      ...declarativeTargets(runtime, integration.slug, providerArguments),
      ...fileIds.map((id) => ({ type: "platform.file", id })),
    ];
    const intent = normalizeToolIntent({
      intentId: derivedId("egress-intent", input.runId, input.toolCallId, runtime.toolId),
      businessId: input.businessId,
      runId: input.runId,
      stateId: `chat:${input.toolCallId}`,
      runStateId: input.stateId,
      toolId: runtime.toolId,
      toolVersion: runtime.contract.spec.toolVersion,
      action: runtime.contract.spec.action,
      targetRefs,
      arguments: providerArguments,
      ...(!producesBinaryFile && fileIds.length === 0
        ? {}
        : {
            filePrincipalId: principal.id,
            ...(fileIds.length === 0 ? {} : { fileIds }),
          }),
      principalKind: principal.kind,
      principalId: principal.id,
      ...(input.agent.principalId === undefined
        ? {}
        : { agentPrincipalId: input.agent.principalId }),
      ...(input.activeSkillName === undefined ? {} : { activeSkillName: input.activeSkillName }),
      integrationId: manifest.metadata.id,
      integrationMajorVersion: oimManifestMajor(manifest),
      operationId: compiled.operation.id,
      manifestDigest: canonicalHash(manifest),
      configurationDigest: canonicalHash(configuration),
      ...(destination === undefined ? {} : { destination }),
      ...(connection === undefined ? {} : { connection }),
      ...(credentialRef === undefined ? {} : { credentialRef }),
      ...(secondaryConnection === undefined ? {} : { secondaryConnection }),
      ...(secondaryCredentialRef === undefined ? {} : { secondaryCredentialRef }),
      idempotencyKey: derivedId(
        "egress-idempotency",
        input.runId,
        input.toolCallId,
        runtime.toolId
      ),
    });
    if (
      input.pinnedIntent !== undefined &&
      intentDigest(input.pinnedIntent) !== intentDigest(intent)
    ) {
      throw new ToolPreparationDeniedError(
        "The approved Connection, configuration, destination, File, or authority binding changed."
      );
    }
    return {
      intent,
      definition: {
        ...definition,
        mutating: runtime.mutating,
        riskClass: runtime.contract.spec.riskClass,
        idempotency: runtime.contract.spec.idempotency.strategy,
        effectiveDestination: destination,
        authorization: {
          ...definition.authorization,
          action: runtime.contract.spec.action,
          ...(destination === undefined ? {} : { allowedDestinations: [destination] }),
        },
        targetsFor: () => targetRefs,
      },
    };
  };
}

function buildToolDef(
  compiled: CompiledDeclarativeTool,
  integration: CompiledIntegration,
  deps: DeclarativeToolingDeps,
  dispatcher: EffectDispatcher
): ParkableToolDef {
  const { slug, credential, credentialMode } = integration;
  const toolName = declarativeToolName(slug, compiled.name);
  const action = compiled.contract.spec.action;

  const definition = defineParkableApiTool<RequestContext>({
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
    async handler(args, ctx): Promise<ParkableToolCallResult> {
      const runId = ctx.runId;
      if (runId === undefined) return err("internal_error", "no run context for this tool call");
      const callId = ctx.toolCallId ?? crypto.randomUUID();
      const stateId = `invoke:${callId}`;
      const toolId = compiled.toolId;

      let activeDispatcher = dispatcher;
      let activeIntegration = integration;
      let intent =
        integration.oimManifest === undefined
          ? undefined
          : ctx.toolIntent === undefined
            ? undefined
            : normalizeToolIntent(ctx.toolIntent);
      if (integration.oimManifest !== undefined) {
        if (intent === undefined || !("operation" in compiled) || deps.connections === undefined) {
          return err("internal_error", "safe Connection dispatch is not available");
        }
        const connection = intent.connection;
        let configuration: Readonly<Record<string, string | number | boolean>> = {};
        if (connection !== undefined) {
          const live = await deps.connections.reauthorizeConnection(
            deps.businessId,
            integration.oimManifest,
            compiled.operation,
            connection,
            intent.credentialRef as `secret://${string}` | undefined
          );
          if (live === null) {
            return err("internal_error", "the approved Connection binding is no longer valid");
          }
          configuration = live.configuration;
        }
        const runtime = compileOimRuntimeTool(compiled, integration, configuration);
        if (
          oimDestination(runtime) !== intent.destination ||
          canonicalHash(configuration) !== intent.configurationDigest ||
          canonicalHash(integration.oimManifest) !== intent.manifestDigest ||
          canonicalHash(
            "multipart" in runtime.binding
              ? extractOimMultipartFileIds(runtime.binding, intent.arguments)
              : []
          ) !== canonicalHash(intent.fileIds ?? [])
        ) {
          return err("internal_error", "the approved provider binding changed");
        }
        if (connection?.credentialSlot !== undefined) {
          const provider = secretsServiceProvider(await deps.secrets());
          const revision =
            intent.credentialRef === undefined
              ? null
              : await provider.currentVersion?.(intent.credentialRef);
          if (revision !== connection.credentialRevision) {
            return err("write_denied", "the approved Connection Credential changed");
          }
          if (intent.secondaryConnection !== undefined) {
            const secondaryRevision =
              intent.secondaryCredentialRef === undefined
                ? null
                : await provider.currentVersion?.(intent.secondaryCredentialRef);
            if (secondaryRevision !== intent.secondaryConnection.credentialRevision) {
              return err("write_denied", "the approved secondary Connection Credential changed");
            }
          }
        }
        const fileIds = intent.fileIds;
        if (fileIds !== undefined && fileIds.length > 0) {
          if (
            deps.authorizeFiles === undefined ||
            intent.principalKind === undefined ||
            intent.principalId === undefined
          ) {
            return err("write_denied", "File access cannot be reauthorized");
          }
          try {
            await deps.authorizeFiles({
              businessId: intent.businessId,
              runId: intent.runId,
              stateId: intent.runStateId ?? intent.stateId,
              caller: { kind: intent.principalKind, id: intent.principalId },
              ...(intent.agentPrincipalId === undefined
                ? {}
                : { agentPrincipalId: intent.agentPrincipalId }),
              fileIds,
            });
          } catch {
            return err("write_denied", "File access was revoked");
          }
        }
        activeIntegration = { ...integration, tools: [runtime] };
        activeDispatcher = dispatcherFor(activeIntegration, deps);
      }

      intent ??= normalizeToolIntent({
        intentId: derivedId("egress-intent", runId, stateId, toolId),
        businessId: deps.businessId,
        runId,
        stateId,
        ...(ctx.stateKey === undefined ? {} : { runStateId: ctx.stateKey }),
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
        effectId: derivedId("egress-effect", runId, intent.stateId, intent.toolId),
        businessId: deps.businessId,
        runId,
        stateId: intent.stateId,
        logicalEffectOrdinal: 0,
        idempotencyKey: intent.idempotencyKey,
        intentDigest: intentDigest(intent),
        intent,
        guardrailRevision: ctx.guardrailRevision ?? "none",
        createdAt: new Date().toISOString(),
      });
      if (reserved.outcome === "duplicate" && reserved.effect.state === "confirmed") {
        return replayed(reserved.effect);
      }

      try {
        const dispatch = () =>
          activeDispatcher.dispatch(deps.businessId, reserved.effect.effectId, ctx.abortSignal);
        const releaseDispatch = deps.releaseDispatch;
        let output: unknown;
        if (activeIntegration.oimManifest === undefined) {
          output = await dispatch();
        } else {
          if (releaseDispatch === undefined) {
            throw new Error("oim_release_dispatch_unavailable");
          }
          output = await releaseDispatch.dispatch(
            {
              businessId: deps.businessId,
              integration: {
                slug: activeIntegration.slug,
                sourceIntegration: activeIntegration.oimManifest.metadata.id,
                oimManifest: activeIntegration.oimManifest,
                ...(activeIntegration.oimPackageFiles === undefined
                  ? {}
                  : { oimPackageFiles: activeIntegration.oimPackageFiles }),
              },
            },
            (providerDispatch) =>
              dispatcherFor(activeIntegration, deps, providerDispatch).dispatch(
                deps.businessId,
                reserved.effect.effectId,
                ctx.abortSignal
              ),
            async (): Promise<OimDispatchSettlement> => {
              const effect = await deps.effects.get(deps.businessId, reserved.effect.effectId);
              if (effect?.state === "confirmed" || effect?.state === "failed") {
                return "settled";
              }
              if (effect?.state === "ambiguous" || effect?.state === "reconciliation_required") {
                return "ambiguous";
              }
              return "not_dispatched";
            }
          );
        }
        return ok(output);
      } catch (error) {
        if (error instanceof EffectDispatchDeferredError) {
          return parked({ kind: "retry_wait", waitId: error.deferred.waitId });
        }
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
  deps: DeclarativeToolingDeps,
  integration: CompiledIntegration
): ToolAdapter | undefined {
  if (
    "operation" in tool &&
    integration.oimManifest !== undefined &&
    (tool.operation.source.type === "http" || tool.operation.source.type === "openapi") &&
    "pathTemplate" in tool.binding
  ) {
    return new OimHttpToolAdapter({
      binding: tool.binding,
      http: deps.http,
      toolId: tool.toolId,
      manifest: integration.oimManifest,
      ...(tool.projection === undefined ? {} : { projection: tool.projection }),
      ...(deps.files === undefined ? {} : { files: deps.files }),
      ...(deps.fileReadAuthorization === undefined
        ? {}
        : { fileReadAuthorization: deps.fileReadAuthorization }),
      ...("pagination" in tool && tool.pagination !== undefined
        ? {
            pagination: tool.pagination,
            ...(deps.paginationRuntime === undefined
              ? {}
              : { paginationRuntime: deps.paginationRuntime }),
          }
        : {}),
    });
  }
  switch (tool.contract.spec.adapter.kind) {
    case "openapi":
      if (!("pathTemplate" in tool.binding)) return undefined;
      return new OpenApiToolAdapter({ binding: tool.binding, http: deps.http });
    case "graphql":
      if (!("document" in tool.binding)) return undefined;
      return "operation" in tool && integration.oimManifest !== undefined
        ? new OimGraphqlToolAdapter({
            binding: tool.binding,
            http: deps.http,
            manifest: integration.oimManifest,
            toolId: tool.toolId,
            ...(tool.projection === undefined ? {} : { projection: tool.projection }),
            ...("pagination" in tool && tool.pagination !== undefined
              ? {
                  pagination: tool.pagination,
                  ...(deps.paginationRuntime === undefined
                    ? {}
                    : { paginationRuntime: deps.paginationRuntime }),
                }
              : {}),
          })
        : new GraphqlToolAdapter({ binding: tool.binding, http: deps.http });
    case "native":
      return undefined;
    default:
      return undefined;
  }
}

function dispatcherFor(
  integration: CompiledIntegration,
  deps: DeclarativeToolingDeps,
  providerDispatch?: OimProviderDispatch
): EffectDispatcher {
  const catalog = ToolCatalog.load(integration.tools.map((tool) => tool.contract));
  const adapters = new Map<string, ToolAdapter>();
  for (const tool of integration.tools) {
    const adapter = adapterFor(tool, deps, integration);
    // A kind with no implementation is left unregistered rather than handed the OpenAPI adapter:
    // the compiler emits the kind, so binding it to a backend it did not declare would let the
    // contract and the runtime disagree in silence. Dispatch then fails `adapter_not_found`,
    // which parks that one Tool instead of failing the whole integration's registration.
    if (adapter !== undefined) {
      adapters.set(
        tool.adapterRef,
        providerDispatch === undefined
          ? adapter
          : {
              kind: adapter.kind,
              dispatch: (request, credential, credentials) =>
                providerDispatch(() => adapter.dispatch(request, credential, credentials)),
            }
      );
    }
  }

  const { credential } = integration;
  const authorizer: SecretAuthorizer = {
    async authorize(scope) {
      if (credential !== undefined) {
        if (
          scope.secretRef === credential.ref ||
          principalOfRef(credential.ref, scope.secretRef) !== null
        ) {
          return { allowed: true, maxTtlMs: 5 * 60 * 1000, maxUses: 1 };
        }
      }
      if (
        integration.oimManifest !== undefined &&
        deps.connections !== undefined &&
        scope.businessId !== undefined &&
        scope.connectionId !== undefined &&
        scope.credentialSlot !== undefined &&
        scope.credentialRevision !== undefined &&
        scope.integrationId === integration.oimManifest.metadata.id &&
        scope.integrationMajorVersion !== undefined &&
        scope.operationId !== undefined &&
        scope.identityMode !== undefined &&
        scope.manifestDigest !== undefined &&
        scope.configurationDigest !== undefined &&
        scope.principalKind !== undefined &&
        scope.principalId !== undefined &&
        scope.secretRef.startsWith("secret://")
      ) {
        const runtimeTool = integration.tools.find(
          (candidate) =>
            "operation" in candidate &&
            candidate.operation.id === scope.operationId &&
            candidate.contract.spec.toolId === scope.toolId
        );
        if (runtimeTool !== undefined && "operation" in runtimeTool) {
          const live = await deps.connections.reauthorizeConnection(
            scope.businessId,
            integration.oimManifest,
            runtimeTool.operation,
            {
              connectionId: scope.connectionId,
              integrationId: scope.integrationId,
              integrationMajorVersion: scope.integrationMajorVersion,
              operationId: scope.operationId,
              credentialSlot: scope.credentialSlot,
              identityMode: scope.identityMode,
              principalKind: scope.principalKind,
              principalId: scope.principalId,
              manifestDigest: scope.manifestDigest,
              configurationDigest: scope.configurationDigest,
            },
            scope.secretRef
          );
          if (
            live !== null &&
            oimDestination(compileOimRuntimeTool(runtimeTool, integration, live.configuration)) ===
              scope.destination
          ) {
            return { allowed: true, maxTtlMs: 5 * 60 * 1000, maxUses: 1 };
          }
        }
      }
      return { allowed: false, reason: "not_authorized" };
    },
  };
  const provider: SecretProvider =
    integration.oimManifest === undefined
      ? credential === undefined
        ? { resolveCurrent: async () => null }
        : new EgressSecretProvider(
            credential.ref,
            credential.storageKey,
            deps.secrets,
            integration.slug,
            credential.tokenEnv
          )
      : {
          async resolveCurrent(secretRef) {
            return await secretsServiceProvider(await deps.secrets()).resolveCurrent(secretRef);
          },
          async resolveUncached(secretRef) {
            return (
              (await secretsServiceProvider(await deps.secrets()).resolveUncached?.(secretRef)) ??
              null
            );
          },
          async currentVersion(secretRef) {
            return (
              (await secretsServiceProvider(await deps.secrets()).currentVersion?.(secretRef)) ??
              null
            );
          },
        };
  const credentials = new CredentialDispatcher({
    secrets: new SecretBroker({
      provider,
      authorizer,
    }),
    reauthorize: async (effect) => {
      const manifest = integration.oimManifest;
      if (manifest === undefined) return true;
      const intent = effect.intent;
      if (
        deps.connections === undefined ||
        intent.integrationId !== manifest.metadata.id ||
        intent.integrationMajorVersion !== oimManifestMajor(manifest) ||
        intent.manifestDigest !== canonicalHash(manifest) ||
        intent.operationId === undefined ||
        intent.principalKind === undefined ||
        intent.principalId === undefined
      ) {
        return false;
      }
      const runtimeTool = integration.tools.find(
        (candidate) => "operation" in candidate && candidate.operation.id === intent.operationId
      );
      if (runtimeTool === undefined || !("operation" in runtimeTool)) return false;
      const principal = { kind: intent.principalKind, id: intent.principalId };
      let configuration: Readonly<Record<string, string | number | boolean>>;
      if (intent.connection === undefined) {
        const resolution = await deps.connections.resolve({
          businessId: effect.businessId,
          manifest,
          operation: runtimeTool.operation,
          principal,
          ...(principal.kind === "user" ? { personalOwnerId: principal.id } : {}),
        });
        if (resolution.kind !== "public") return false;
        configuration = {};
      } else {
        const credentialRef = intent.credentialRef as `secret://${string}` | undefined;
        const live = await deps.connections.reauthorizeConnection(
          effect.businessId,
          manifest,
          runtimeTool.operation,
          intent.connection,
          credentialRef
        );
        if (live === null) return false;
        configuration = live.configuration;
        if (
          intent.secondaryConnection !== undefined &&
          (intent.secondaryCredentialRef === undefined ||
            (await deps.connections.reauthorizeConnection(
              effect.businessId,
              manifest,
              runtimeTool.operation,
              intent.secondaryConnection,
              intent.secondaryCredentialRef as `secret://${string}`
            )) === null)
        ) {
          return false;
        }
      }
      const current = compileOimRuntimeTool(runtimeTool, integration, configuration);
      const currentFiles =
        "multipart" in current.binding
          ? extractOimMultipartFileIds(current.binding, intent.arguments)
          : [];
      return (
        canonicalHash(configuration) === intent.configurationDigest &&
        oimDestination(current) === intent.destination &&
        canonicalHash(currentFiles) === canonicalHash(intent.fileIds ?? [])
      );
    },
  });

  return new EffectDispatcher({
    store: deps.effects,
    catalog,
    adapters,
    credentialDispatcher: credentials,
    ...(deps.parkRetry === undefined ? {} : { parkRetry: deps.parkRetry }),
    ...(deps.retryWaitStatus === undefined ? {} : { retryWaitStatus: deps.retryWaitStatus }),
    ...(deps.mutationGuard === undefined
      ? {}
      : {
          mutationGuard: deps.mutationGuard,
          mutationIdentity: { integrationId: integration.slug },
        }),
  });
}

export interface DeclarativeTooling {
  readonly tools: readonly ParkableToolDef[];
  readonly preparation: ToolCallPreparationPort;
  /** Why an integration published nothing, for the operator-facing log. */
  readonly problems: readonly string[];
}

/** Builds Tools only for connected integrations; malformed declarations report problems. */
export function buildDeclarativeTools(
  integrations: readonly SoulIntegration[],
  deps: DeclarativeToolingDeps,
  logger?: Logger
): DeclarativeTooling {
  const tools: ParkableToolDef[] = [];
  const problems: string[] = [];
  const toolOwners = new Map<string, string>();
  const preparers = new Map<string, OimPreparer>();
  const replayers = new Map<string, OimConfirmedReplayer>();

  for (const integration of integrations) {
    if (integration.manifest === undefined && integration.oimManifest === undefined) continue;
    if (integration.oimManifest !== undefined && deps.connections === undefined) continue;
    try {
      const compiled = compileIntegration(integration);
      if (compiled.tools.length === 0) continue;

      const dispatcher = dispatcherFor(compiled, deps);
      const built = compiled.tools.map((tool) => buildToolDef(tool, compiled, deps, dispatcher));
      for (const [index, tool] of built.entries()) {
        const owner = toolOwners.get(tool.name);
        if (owner !== undefined && owner !== integration.slug) {
          const problem = `Integration "${integration.slug}" skipped Tool "${tool.name}": tool name collides with integration "${owner}"`;
          problems.push(problem);
          logger?.error(problem);
          continue;
        }
        toolOwners.set(tool.name, integration.slug);
        tools.push(tool);
        const compiledTool = compiled.tools[index];
        if (
          compiledTool !== undefined &&
          integration.oimManifest !== undefined &&
          tool.definition !== undefined
        ) {
          preparers.set(tool.name, oimPreparer(compiledTool, compiled, deps, tool.definition));
          replayers.set(tool.name, oimConfirmedReplayer(compiledTool, deps));
        }
      }
    } catch (error) {
      const problem = `Integration "${integration.slug}" published no Tools: ${
        error instanceof Error ? error.message : String(error)
      }`;
      problems.push(problem);
      logger?.error(problem);
    }
  }

  return {
    tools,
    problems,
    preparation: {
      replayConfirmed: async (input) => await replayers.get(input.tool.name)?.(input),
      prepare: async (input) => await preparers.get(input.tool.name)?.(input),
    },
  };
}
