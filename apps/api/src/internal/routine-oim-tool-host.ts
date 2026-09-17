import {
  type AuthorityLayer,
  compileRoutineAuthority,
  decideEffectivePermission,
} from "@tulipfarm/authz";
import {
  type CompiledOimCompositeTool,
  type CompiledOimGraphqlTool,
  type CompiledOimHttpTool,
  type CompiledOimOpenApiTool,
  compileOimCompositeOperations,
  compileOimGraphqlOperations,
  compileOimHttpOperations,
  compileOimOpenApiOperations,
  type EgressHttpPort,
  extractOimMultipartFileIds,
  OimCompositeToolAdapter,
  type OimFilePort,
  type OimFileReadAuthorizationPort,
  OimGraphqlToolAdapter,
  type OimHookPhaseRunner,
  OimHttpToolAdapter,
  type OimOperationConnectionResolver,
  type OimPaginationRuntime,
  oimManifestMajor,
  runOimHookPhase,
} from "@tulipfarm/integrations";
import { routineStateDefinitionRef } from "@tulipfarm/run-kernel";
import type { HookExecutor } from "@tulipfarm/sandbox";
import {
  ajv,
  canonicalHash,
  type OimManifest,
  type OimOperation,
  oimFileDigest,
  oimToolId,
  type routine,
  type ToolContractDefinition,
} from "@tulipfarm/schema";
import {
  type SecretAuthorizer,
  SecretBroker,
  type SecretProvider,
  type SecretsService,
  secretsServiceProvider,
} from "@tulipfarm/secrets";
import {
  type BundleStore,
  type BundleVerifier,
  type RuntimeBundle,
  type SoulIntegration,
  verifyExecutionBundle,
} from "@tulipfarm/soul";
import type {
  PersistedConnection,
  PersistedRun,
  PersistedState,
  RunBundle,
  RunStore,
} from "@tulipfarm/storage";
import {
  AdapterDispatchError,
  CredentialDispatcher,
  deriveContractTargets,
  type EffectRecord,
  type EffectStore,
  intentDigest,
  normalizeToolIntent,
  publishToolContract,
  type ToolAdapter,
  type ToolAdapterRequest,
  type ToolConnectionBinding,
  ToolTargetDerivationError,
  type ToolTargetRef,
} from "@tulipfarm/tool-broker";
import {
  type AuthorityPrincipal,
  agentCapabilityDenial,
  type LiveAuthorityLayerResolver,
  principalKindOf,
} from "@tulipfarm/tool-host";
import type {
  OimDispatchSettlement,
  OimReleaseDispatchPort,
} from "../integrations/releases/dispatch-host";
import type { RunAuthority } from "./turn-host";

export interface RoutineOimRegistration {
  readonly manifest: OimManifest;
  readonly documents?: Readonly<Record<string, string>>;
  readonly openApiDocuments?: Readonly<Record<string, unknown>>;
  readonly hookFiles?: Readonly<Record<string, string>>;
}

/**
 * Immutable host metadata created when the ToolContract is registered for a published bundle.
 *
 * Implementations must key by every field. Falling back to the active Soul would let a later
 * manifest revision change the provider request made by an older Run.
 */
export interface RoutineOimRegistrationReader {
  find(input: {
    readonly businessId: string;
    readonly bundleDigest: string;
    readonly contractId: string;
    readonly contractHash: string;
  }): Promise<RoutineOimRegistration | undefined>;
}

export interface RoutineOimBundleReader {
  load(businessId: string, digest: string): Promise<RuntimeBundle | undefined>;
}

/** Opens only the exact signed bundle the Run named, and rejects cross-business reuse. */
export class VerifiedRoutineOimBundleReader implements RoutineOimBundleReader {
  constructor(
    private readonly bundles: Pick<BundleStore, "get">,
    private readonly verifier: BundleVerifier
  ) {}

  async load(businessId: string, digest: string): Promise<RuntimeBundle | undefined> {
    const record = await this.bundles.get(digest);
    if (record === undefined) return undefined;
    const bundle = verifyExecutionBundle(record, this.verifier);
    return bundle.businessId === businessId && bundle.digest === digest ? bundle : undefined;
  }
}

export interface RoutineOimClaimEvidence {
  readonly leaseOwner: string;
  readonly leaseGeneration: number;
}

export interface RoutineOimClaimedRun {
  readonly authority: RunAuthority;
  readonly bundle: RunBundle;
  readonly state: Pick<PersistedState, "key" | "definitionRef" | "status">;
}

export interface RoutineOimRunAuthority {
  claim(input: {
    readonly businessId: string;
    readonly runId: string;
    readonly stateKey: string;
    readonly claim: RoutineOimClaimEvidence;
  }): Promise<RoutineOimClaimedRun | undefined>;
}

export class LiveRoutineOimRunAuthority implements RoutineOimRunAuthority {
  constructor(
    private readonly authorityHost: {
      authority(businessId: string, runId: string): Promise<RunAuthority>;
    },
    private readonly runs: Pick<RunStore, "find" | "findState">,
    private readonly now: () => Date = () => new Date()
  ) {}

  async claim(input: {
    readonly businessId: string;
    readonly runId: string;
    readonly stateKey: string;
    readonly claim: RoutineOimClaimEvidence;
  }): Promise<RoutineOimClaimedRun | undefined> {
    const initialRun = await this.runs.find(input.businessId, input.runId);
    if (!this.validClaim(initialRun, input.claim)) return undefined;
    const initialState = await this.runs.findState(input.businessId, input.runId, input.stateKey);
    if (initialState === null || initialState.status !== "running") return undefined;
    let authority: RunAuthority;
    try {
      authority = await this.authorityHost.authority(input.businessId, input.runId);
    } catch {
      return undefined;
    }
    const state = await this.runs.findState(input.businessId, input.runId, input.stateKey);
    if (
      state === null ||
      state.status !== "running" ||
      state.definitionRef !== initialState.definitionRef ||
      state.version !== initialState.version
    ) {
      return undefined;
    }
    const run = await this.runs.find(input.businessId, input.runId);
    if (!this.validClaim(run, input.claim)) return undefined;
    if (
      run.source !== initialRun.source ||
      run.bundle.digest !== initialRun.bundle.digest ||
      run.bundle.routineId !== initialRun.bundle.routineId ||
      run.bundle.routineVersion !== initialRun.bundle.routineVersion ||
      authority.businessId !== run.businessId ||
      authority.runId !== run.id ||
      authority.bundleDigest !== run.bundle.digest
    ) {
      return undefined;
    }
    return { authority, bundle: run.bundle, state };
  }

  private validClaim(
    run: PersistedRun | null,
    claim: RoutineOimClaimEvidence
  ): run is PersistedRun {
    return (
      run !== null &&
      run.status === "running" &&
      run.leaseOwner === claim.leaseOwner &&
      run.leaseGeneration === claim.leaseGeneration &&
      run.leaseExpiresAt !== null &&
      new Date(run.leaseExpiresAt).getTime() > this.now().getTime()
    );
  }
}

export interface RoutineOimLiveAuthorizer {
  authorize(input: {
    readonly authority: RunAuthority;
    readonly bundle: RuntimeBundle;
    readonly contract: ToolContractDefinition;
    readonly action: string;
    readonly arguments: unknown;
    readonly targetRefs: readonly ToolTargetRef[];
    readonly destination?: string;
  }): Promise<boolean>;
}

export interface RoutineOimFileAuthorizer {
  assertAuthorized(input: {
    readonly authority: RunAuthority;
    readonly bundle: RuntimeBundle;
    readonly contract: ToolContractDefinition;
    readonly stateKey: string;
    readonly fileIds: readonly string[];
  }): Promise<void>;
}

export interface RoutineOimFileAuthorityPort {
  assertAuthorized(input: {
    readonly businessId: string;
    readonly runId: string;
    readonly stateId: string;
    readonly caller: { readonly kind: string; readonly id: string };
    readonly agentPrincipalId?: string;
    readonly fileIds: readonly string[];
  }): Promise<void>;
}

export class LiveRoutineOimFileAuthorizer implements RoutineOimFileAuthorizer {
  constructor(private readonly authority: RoutineOimFileAuthorityPort) {}

  async assertAuthorized(input: Parameters<RoutineOimFileAuthorizer["assertAuthorized"]>[0]) {
    await this.authority.assertAuthorized({
      businessId: input.authority.businessId,
      runId: input.authority.runId,
      stateId: input.stateKey,
      caller: input.authority.subject,
      ...(input.authority.agent?.principalId === undefined
        ? {}
        : { agentPrincipalId: input.authority.agent.principalId }),
      fileIds: input.fileIds,
    });
  }
}

/**
 * Re-checks the live caller layer against the pinned Routine ToolContract.
 *
 * The pinned Routine layer is included as a ceiling. Connection ownership and credential scope
 * remain the Connection resolver's separate live layer.
 */
export class LiveRoutineOimAuthorizer implements RoutineOimLiveAuthorizer {
  constructor(private readonly layers: Pick<LiveAuthorityLayerResolver, "resolvePrincipalLayer">) {}

  async authorize(input: {
    readonly authority: RunAuthority;
    readonly bundle: RuntimeBundle;
    readonly contract: ToolContractDefinition;
    readonly action: string;
    readonly arguments: unknown;
    readonly targetRefs: readonly ToolTargetRef[];
    readonly destination?: string;
  }): Promise<boolean> {
    const { authority, contract } = input;
    if (input.action !== contract.spec.action) return false;
    if (authority.agent?.unresolvedRef !== undefined) return false;
    if (
      authority.agent?.toolAllowlist !== undefined &&
      !authority.agent.toolAllowlist.includes(contract.spec.toolId)
    ) {
      return false;
    }
    if (
      agentCapabilityDenial(
        authority.agent?.capabilityRestrictions,
        { name: contract.spec.toolId, mutating: contract.spec.mutating },
        input.arguments
      ) !== undefined
    ) {
      return false;
    }
    const kind = principalKindOf(authority.subject.kind);
    if (kind === undefined) return false;
    const principal: AuthorityPrincipal = {
      id: authority.subject.id,
      businessId: authority.businessId,
      kind,
    };
    const caller = await this.layers.resolvePrincipalLayer(kind, principal);
    const agent =
      authority.agent?.principalId === undefined
        ? undefined
        : await this.layers.resolvePrincipalLayer("agent", {
            id: authority.agent.principalId,
            businessId: authority.businessId,
            kind: "agent",
          });
    const routine: AuthorityLayer = {
      name: `routine:${authority.routineId ?? "unknown"}`,
      grants: compileRoutineAuthority([contract]),
    };
    const actions =
      contract.spec.requiredActions && contract.spec.requiredActions.length > 0
        ? contract.spec.requiredActions
        : [input.action];
    const targets =
      input.targetRefs.length > 0
        ? input.targetRefs
        : (contract.spec.requiredResources ?? []).map((type) => ({ type }));
    const protectedTargets =
      targets.length > 0
        ? targets
        : [{ type: "Tool", id: contract.spec.toolId as string | undefined }];
    return actions.every((action) =>
      protectedTargets.every(
        (target) =>
          decideEffectivePermission(
            agent === undefined ? [caller, routine] : [caller, agent, routine],
            {
              action,
              resourceType: target.type,
              recordId: "id" in target ? target.id : undefined,
              ...("domain" in target && target.domain !== undefined
                ? { domain: target.domain }
                : {}),
              ...(contract.spec.dataClasses?.[0] === undefined
                ? {}
                : { dataClass: contract.spec.dataClasses[0] }),
              ...(input.destination === undefined ? {} : { destination: input.destination }),
            }
          ).allowed
      )
    );
  }
}

export type RoutineOimPreparationResult =
  | { readonly kind: "unmanaged" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      readonly kind: "ready";
      readonly adapter: {
        readonly kind: ToolContractDefinition["spec"]["adapter"]["kind"];
        readonly ref: string;
      };
      readonly destination?: string;
      readonly credentialRef?: string;
      readonly connection?: EffectRecord["intent"]["connection"];
      readonly secondaryCredentialRef?: string;
      readonly secondaryConnection?: EffectRecord["intent"]["secondaryConnection"];
      readonly filePrincipalId?: string;
      readonly fileIds?: readonly string[];
      readonly agentPrincipalId?: string;
      readonly integrationId: string;
      readonly integrationMajorVersion: number;
      readonly operationId: string;
      readonly manifestDigest: string;
      readonly configurationDigest: string;
    };

export type RoutineOimDispatchResult =
  | { readonly kind: "succeeded"; readonly output: unknown }
  | {
      readonly kind: "failed";
      readonly error: {
        readonly phase: "before_dispatch" | "after_dispatch";
        readonly code: string;
        readonly retryable: boolean;
        readonly providerRequestId?: string;
        readonly retryAfterMs?: number;
      };
    };

type CompiledRoutineOimTool =
  | CompiledOimHttpTool
  | CompiledOimOpenApiTool
  | CompiledOimGraphqlTool
  | CompiledOimCompositeTool;

export interface InternalRoutineOimToolHostOptions {
  readonly businessId: string;
  readonly releaseIntegration: (manifest: OimManifest) => SoulIntegration | undefined;
  readonly releaseDispatch: OimReleaseDispatchPort;
  readonly runs: RoutineOimRunAuthority;
  readonly bundles: RoutineOimBundleReader;
  readonly registrations: RoutineOimRegistrationReader;
  readonly connections: OimOperationConnectionResolver;
  readonly effects: Pick<EffectStore, "get" | "listAttempts">;
  readonly secrets: () => Promise<SecretsService>;
  readonly http: EgressHttpPort;
  readonly authorize: RoutineOimLiveAuthorizer;
  readonly hookExecutor?: Pick<HookExecutor, "runPureHook">;
  readonly files?: OimFilePort;
  readonly fileAuthorizer?: RoutineOimFileAuthorizer;
  readonly paginationRuntime?: OimPaginationRuntime;
  /** Adds durable quota/cooldown policy without moving provider execution out of this host. */
  readonly decorateAdapter?: (
    adapter: ToolAdapter,
    manifest: OimManifest,
    operation: OimOperation
  ) => ToolAdapter;
}

export interface InternalRoutineOimToolHostFactoryOptions
  extends Omit<
    InternalRoutineOimToolHostOptions,
    | "runs"
    | "bundles"
    | "authorize"
    | "fileAuthorizer"
    | "files"
    | "paginationRuntime"
    | "hookExecutor"
  > {
  readonly runAuthorityHost: {
    authority(businessId: string, runId: string): Promise<RunAuthority>;
  };
  readonly runStore: Pick<RunStore, "find" | "findState">;
  readonly bundleStore: Pick<BundleStore, "get">;
  readonly bundleVerifier: BundleVerifier;
  readonly authorityLayers: Pick<LiveAuthorityLayerResolver, "resolvePrincipalLayer">;
  readonly fileAuthority: RoutineOimFileAuthorityPort;
  readonly files: OimFilePort;
  readonly paginationRuntime: OimPaginationRuntime;
  readonly hookExecutor: Pick<HookExecutor, "runPureHook">;
}

export function createInternalRoutineOimToolHost(
  options: InternalRoutineOimToolHostFactoryOptions
): InternalRoutineOimToolHost {
  const {
    runAuthorityHost,
    runStore,
    bundleStore,
    bundleVerifier,
    authorityLayers,
    fileAuthority,
    ...host
  } = options;
  return new InternalRoutineOimToolHost({
    ...host,
    runs: new LiveRoutineOimRunAuthority(runAuthorityHost, runStore),
    bundles: new VerifiedRoutineOimBundleReader(bundleStore, bundleVerifier),
    authorize: new LiveRoutineOimAuthorizer(authorityLayers),
    fileAuthorizer: new LiveRoutineOimFileAuthorizer(fileAuthority),
  });
}

function toolContract(
  bundle: RuntimeBundle,
  toolId: string,
  toolVersion: string
):
  | {
      readonly definition: RuntimeBundle["definitions"][number];
      readonly contract: ToolContractDefinition;
    }
  | undefined {
  const definition = bundle.definitions.find((candidate) => {
    if (candidate.kind !== "ToolContract") return false;
    const document = candidate.document as unknown as ToolContractDefinition;
    return document.spec.toolId === toolId && document.spec.toolVersion === toolVersion;
  });
  if (definition === undefined) return undefined;
  return {
    definition,
    contract: definition.document as unknown as ToolContractDefinition,
  };
}

function operationFor(
  registration: RoutineOimRegistration,
  toolId: string
): OimOperation | undefined {
  return registration.manifest.operations.find(
    (operation) => oimToolId(registration.manifest, operation.id) === toolId
  );
}

function routineToolState(
  bundle: RuntimeBundle,
  authority: RunAuthority,
  runBundle: RunBundle,
  persistedState: RoutineOimClaimedRun["state"],
  input: {
    readonly action?: string;
  }
): Extract<routine.RoutineState, { readonly type: "tool" }> | undefined {
  if (authority.routineId === undefined) return undefined;
  const definition = bundle.getById(authority.routineId);
  if (definition?.kind !== "Routine") return undefined;
  const routineDefinition = definition.document as unknown as routine.RoutineDefinition;
  const states = routineDefinition.spec.states.filter(
    (state): state is Extract<routine.RoutineState, { readonly type: "tool" }> =>
      state.type === "tool" &&
      persistedState.definitionRef === routineStateDefinitionRef(runBundle, state.name) &&
      (input.action === undefined || state.action === input.action)
  );
  return states.length === 1 ? states[0] : undefined;
}

function configurationOf(
  value: Readonly<Record<string, string | number | boolean>>
): Readonly<Record<string, string | number | boolean>> {
  return value;
}

function configuredBinding(
  manifest: OimManifest,
  operation: OimOperation,
  connection: PersistedConnection,
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

function compileTool(
  registration: RoutineOimRegistration,
  operation: OimOperation,
  configuration: Readonly<Record<string, string | number | boolean>>,
  manifest: OimManifest = registration.manifest
): CompiledRoutineOimTool | undefined {
  return [
    ...compileOimHttpOperations(manifest, configuration),
    ...compileOimOpenApiOperations(
      manifest,
      new Map(Object.entries(registration.openApiDocuments ?? {})),
      configuration
    ),
    ...compileOimGraphqlOperations(
      manifest,
      new Map(Object.entries(registration.documents ?? {})),
      configuration
    ),
    ...compileOimCompositeOperations(
      manifest,
      new Map(Object.entries(registration.documents ?? {})),
      new Map(Object.entries(registration.openApiDocuments ?? {})),
      configuration
    ),
  ].find((candidate) => candidate.operation.id === operation.id);
}

function destinationOf(tool: CompiledRoutineOimTool): string | undefined {
  if ("baseUrl" in tool.binding) return new URL(tool.binding.baseUrl).origin;
  return "url" in tool.binding ? new URL(tool.binding.url).origin : undefined;
}

function hookRunnerFor(
  registration: RoutineOimRegistration,
  businessId: string,
  bundleDigest: string,
  executor: Pick<HookExecutor, "runPureHook"> | undefined
): OimHookPhaseRunner | undefined {
  if ((registration.manifest.hooks ?? []).length === 0) return undefined;
  return {
    run: async (hook, input) => {
      if (executor === undefined) {
        throw new AdapterDispatchError("before_dispatch", "hook_runtime_unavailable", false);
      }
      const source = registration.hookFiles?.[hook.file];
      const file = registration.manifest.files?.find(
        (candidate) => candidate.path === hook.file && candidate.role === "hook"
      );
      if (source === undefined || file === undefined) {
        throw new AdapterDispatchError("before_dispatch", "hook_source_unavailable", false);
      }
      if (oimFileDigest(source) !== file.sha256) {
        throw new AdapterDispatchError("before_dispatch", "hook_source_mismatch", false);
      }
      return executor.runPureHook({
        source,
        sourceSha256: file.sha256,
        exportName: hook.export,
        input,
        breakerKey: [
          "oim-routine",
          businessId,
          bundleDigest,
          canonicalHash(registration.manifest),
          hook.kind,
          hook.export,
        ].join(":"),
      });
    },
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

async function validateAndShapeRequest(
  request: ToolAdapterRequest,
  contract: ToolContractDefinition,
  operation: OimOperation,
  manifest: OimManifest,
  runner: OimHookPhaseRunner | undefined
): Promise<ToolAdapterRequest> {
  try {
    const validation = await runOimHookPhase({
      manifest,
      kind: "input_validate",
      input: { operationId: operation.id, arguments: request.intent.arguments },
      ...(runner === undefined ? {} : { runner }),
    });
    if (validation.executed) {
      const result = record(validation.value);
      if (result?.valid === false && typeof result.message === "string") {
        throw new AdapterDispatchError("before_dispatch", "input_validation_failed", false);
      }
      if (result?.valid !== true) {
        throw new AdapterDispatchError("before_dispatch", "input_validate_hook_invalid", false);
      }
    }
  } catch (error) {
    if (error instanceof AdapterDispatchError) throw error;
    throw new AdapterDispatchError("before_dispatch", "input_validate_hook_failed", false);
  }

  try {
    const shaped = await runOimHookPhase({
      manifest,
      kind: "request_shape",
      input: { operationId: operation.id, arguments: request.intent.arguments },
      ...(runner === undefined ? {} : { runner }),
    });
    if (!shaped.executed) return request;
    if (
      record(shaped.value) === undefined ||
      !ajv.compile(contract.spec.inputSchema)(shaped.value)
    ) {
      throw new AdapterDispatchError("before_dispatch", "request_shape_hook_invalid", false);
    }
    let targets: readonly ToolTargetRef[];
    try {
      targets = deriveContractTargets(publishToolContract(contract), shaped.value);
    } catch (error) {
      if (error instanceof ToolTargetDerivationError) {
        throw new AdapterDispatchError("before_dispatch", error.code, false);
      }
      throw error;
    }
    if (canonicalHash(targets) !== canonicalHash(request.intent.targetRefs)) {
      throw new AdapterDispatchError("before_dispatch", "request_shape_target_mismatch", false);
    }
    return {
      ...request,
      intent: {
        ...request.intent,
        arguments: structuredClone(shaped.value),
      },
    };
  } catch (error) {
    if (error instanceof AdapterDispatchError) throw error;
    throw new AdapterDispatchError("before_dispatch", "request_shape_hook_failed", false);
  }
}

function adapterOf(
  tool: CompiledRoutineOimTool,
  options: Pick<
    InternalRoutineOimToolHostOptions,
    "http" | "files" | "fileAuthorizer" | "paginationRuntime" | "decorateAdapter"
  >,
  manifest: OimManifest,
  runner: OimHookPhaseRunner | undefined,
  fileReadAuthorization: OimFileReadAuthorizationPort | undefined
): ToolAdapter {
  if (tool.operation.source.type === "composite") {
    const composite = tool as CompiledOimCompositeTool;
    return new OimCompositeToolAdapter({
      steps: composite.steps.map((step) => ({
        ...step,
        adapter: adapterOf(step.tool, options, manifest, runner, fileReadAuthorization),
        contract: step.tool.contract,
      })),
    });
  }
  let adapter: ToolAdapter;
  if (tool.operation.source.type === "graphql") {
    if (!("document" in tool.binding)) {
      throw new AdapterDispatchError("before_dispatch", "adapter_binding_mismatch", false);
    }
    adapter = new OimGraphqlToolAdapter({
      binding: tool.binding,
      http: options.http,
      manifest,
      ...(runner === undefined ? {} : { hookRunner: runner }),
      ...(tool.projection === undefined ? {} : { projection: tool.projection }),
      ...(!("pagination" in tool) || tool.pagination === undefined
        ? {}
        : {
            pagination: tool.pagination,
            ...(options.paginationRuntime === undefined
              ? {}
              : { paginationRuntime: options.paginationRuntime }),
          }),
      toolId: tool.contract.spec.toolId,
    });
  } else {
    if (!("pathTemplate" in tool.binding)) {
      throw new AdapterDispatchError("before_dispatch", "adapter_binding_mismatch", false);
    }
    adapter = new OimHttpToolAdapter({
      binding: tool.binding,
      http: options.http,
      manifest,
      ...(runner === undefined ? {} : { hookRunner: runner }),
      toolId: tool.contract.spec.toolId,
      ...(tool.projection === undefined ? {} : { projection: tool.projection }),
      ...(!("pagination" in tool) || tool.pagination === undefined
        ? {}
        : {
            pagination: tool.pagination,
            ...(options.paginationRuntime === undefined
              ? {}
              : { paginationRuntime: options.paginationRuntime }),
          }),
      ...(options.files === undefined ? {} : { files: options.files }),
      ...(fileReadAuthorization === undefined ? {} : { fileReadAuthorization }),
    });
  }
  return options.decorateAdapter?.(adapter, manifest, tool.operation) ?? adapter;
}

export class InternalRoutineOimToolHost {
  constructor(private readonly options: InternalRoutineOimToolHostOptions) {}

  async prepare(
    runId: string,
    input: {
      readonly stateKey: string;
      readonly connectionId?: string;
      readonly arguments: unknown;
      readonly claim: RoutineOimClaimEvidence;
    }
  ): Promise<RoutineOimPreparationResult> {
    const context = await this.context(runId, {
      stateKey: input.stateKey,
      claim: input.claim,
    });
    if (context.kind !== "ready") return context;
    const { authority, bundle, contract, registration, operation } = context;
    const resolved = await this.options.connections.resolve({
      businessId: this.options.businessId,
      manifest: registration.manifest,
      operation,
      principal: authority.subject,
      ...(authority.subject.kind === "user" ? { personalOwnerId: authority.subject.id } : {}),
      ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
    });
    if (resolved.kind !== "public" && resolved.kind !== "configured" && resolved.kind !== "ready") {
      return {
        kind: "failed",
        reason:
          resolved.kind === "connection_denied" ? `connection_${resolved.reason}` : resolved.kind,
      };
    }

    const configuration = resolved.kind === "public" ? {} : resolved.connection.configuration;
    const runtimeManifest = registration.manifest;
    const compiled = compileTool(
      registration,
      operation,
      configurationOf(configuration),
      runtimeManifest
    );
    if (compiled === undefined) return { kind: "unavailable", reason: "oim_compile_failed" };
    if (
      "pagination" in compiled &&
      compiled.pagination !== undefined &&
      this.options.paginationRuntime === undefined
    ) {
      return { kind: "unavailable", reason: "pagination_runtime_missing" };
    }
    const fileIds =
      "multipart" in compiled.binding || "mime" in compiled.binding
        ? extractOimMultipartFileIds(compiled.binding, input.arguments)
        : [];
    let targetRefs: readonly ToolTargetRef[];
    try {
      targetRefs = deriveContractTargets(publishToolContract(contract), input.arguments);
    } catch (error) {
      return {
        kind: "failed",
        reason: error instanceof ToolTargetDerivationError ? error.code : "target_invalid",
      };
    }
    if (
      !(await this.options.authorize.authorize({
        authority,
        bundle,
        contract,
        action: contract.spec.action,
        arguments: input.arguments,
        targetRefs,
        destination: destinationOf(compiled),
      }))
    ) {
      return { kind: "failed", reason: "authorization_revoked" };
    }
    if (fileIds.length > 0) {
      if (this.options.fileAuthorizer === undefined) {
        return { kind: "unavailable", reason: "file_authorizer_missing" };
      }
      try {
        await this.options.fileAuthorizer.assertAuthorized({
          authority,
          bundle,
          contract,
          stateKey: input.stateKey,
          fileIds,
        });
      } catch {
        return { kind: "failed", reason: "file_access_denied" };
      }
    }

    const ready = this.prepared(
      authority,
      contract,
      compiled,
      registration.manifest,
      configuration,
      fileIds
    );
    if (ready.kind !== "ready") return ready;
    if (resolved.kind === "public") return ready;
    if (resolved.kind === "configured") {
      return {
        ...ready,
        connection: configuredBinding(
          registration.manifest,
          operation,
          resolved.connection,
          authority.subject
        ),
      };
    }
    const provider = secretsServiceProvider(await this.options.secrets());
    const revision = await provider.currentVersion?.(resolved.credentialRef);
    if (revision == null) return { kind: "failed", reason: "credential_revoked" };
    const connection = { ...resolved.binding, credentialRevision: revision };
    let secondaryConnection: ToolConnectionBinding | undefined;
    if (resolved.secondaryBinding !== undefined && resolved.secondaryCredentialRef !== undefined) {
      const secondaryRevision = await provider.currentVersion?.(resolved.secondaryCredentialRef);
      if (secondaryRevision == null) return { kind: "failed", reason: "credential_revoked" };
      secondaryConnection = {
        ...resolved.secondaryBinding,
        credentialRevision: secondaryRevision,
      };
    }
    return {
      ...ready,
      credentialRef: resolved.credentialRef,
      connection,
      ...(resolved.secondaryCredentialRef === undefined || resolved.secondaryBinding === undefined
        ? {}
        : {
            secondaryCredentialRef: resolved.secondaryCredentialRef,
            secondaryConnection,
          }),
    };
  }

  async dispatch(
    runId: string,
    effectId: string,
    input: { readonly attempt: number; readonly claim: RoutineOimClaimEvidence }
  ): Promise<RoutineOimDispatchResult> {
    const effect = await this.options.effects.get(this.options.businessId, effectId);
    if (effect === undefined || effect.runId !== runId) {
      return this.failed("before_dispatch", "effect_not_found", false);
    }
    try {
      const intent = normalizeToolIntent(effect.intent);
      if (
        intentDigest(intent) !== effect.intentDigest ||
        intent.intentId !== effect.effectId ||
        intent.businessId !== effect.businessId ||
        intent.runId !== effect.runId ||
        intent.stateId !== effect.stateId ||
        intent.idempotencyKey !== effect.idempotencyKey
      ) {
        return this.failed("before_dispatch", "effect_evidence_invalid", false);
      }
    } catch {
      return this.failed("before_dispatch", "effect_evidence_invalid", false);
    }
    const attempts = await this.options.effects.listAttempts(this.options.businessId, effectId);
    const attempt = attempts.at(-1);
    if (
      effect.state !== "dispatched" ||
      attempt?.attempt !== input.attempt ||
      attempt.state !== "dispatched"
    ) {
      return this.failed("before_dispatch", "effect_attempt_mismatch", false);
    }
    const context = await this.context(runId, {
      stateKey: effect.stateId,
      action: effect.intent.action,
      claim: input.claim,
    });
    if (context.kind !== "ready") {
      return this.failed(
        "before_dispatch",
        context.kind === "unmanaged" ? "unmanaged_tool" : context.reason,
        false
      );
    }
    if (
      context.contract.spec.toolId !== effect.intent.toolId ||
      context.contract.spec.toolVersion !== effect.intent.toolVersion
    ) {
      return this.failed("before_dispatch", "routine_state_mismatch", false);
    }
    if (
      !(await this.options.authorize.authorize({
        authority: context.authority,
        bundle: context.bundle,
        contract: context.contract,
        action: effect.intent.action,
        arguments: effect.intent.arguments,
        targetRefs: effect.intent.targetRefs,
        ...(effect.intent.destination === undefined
          ? {}
          : { destination: effect.intent.destination }),
      }))
    ) {
      return this.failed("before_dispatch", "authorization_revoked", false);
    }

    const intent = effect.intent;
    if (
      intent.integrationId !== context.registration.manifest.metadata.id ||
      intent.integrationMajorVersion !== oimManifestMajor(context.registration.manifest) ||
      intent.operationId !== context.operation.id ||
      intent.manifestDigest !== canonicalHash(context.registration.manifest) ||
      intent.principalKind !== context.authority.subject.kind ||
      intent.principalId !== context.authority.subject.id
    ) {
      return this.failed("before_dispatch", "authorization_revoked", false);
    }

    let configuration: Readonly<Record<string, string | number | boolean>> = {};
    const runtimeManifest = context.registration.manifest;
    let credentials: CredentialDispatcher | undefined;
    if (intent.connection === undefined) {
      const resolution = await this.options.connections.resolve({
        businessId: this.options.businessId,
        manifest: context.registration.manifest,
        operation: context.operation,
        principal: context.authority.subject,
        ...(context.authority.subject.kind === "user"
          ? { personalOwnerId: context.authority.subject.id }
          : {}),
      });
      if (resolution.kind !== "public") {
        return this.failed("before_dispatch", "connection_binding_mismatch", false);
      }
    } else {
      const credentialRef = intent.credentialRef as `secret://${string}` | undefined;
      const currentConnection = await this.options.connections.reauthorizeConnection(
        this.options.businessId,
        context.registration.manifest,
        context.operation,
        intent.connection,
        credentialRef
      );
      if (currentConnection === null) {
        return this.failed("before_dispatch", "authorization_revoked", false);
      }
      configuration = currentConnection.configuration;
      const secondaryConnection = intent.secondaryConnection;
      const secondaryCredentialRef = intent.secondaryCredentialRef;
      if (
        (secondaryConnection === undefined) !== (secondaryCredentialRef === undefined) ||
        (secondaryConnection !== undefined &&
          secondaryCredentialRef !== undefined &&
          (await this.options.connections.reauthorizeConnection(
            this.options.businessId,
            context.registration.manifest,
            context.operation,
            secondaryConnection,
            secondaryCredentialRef as `secret://${string}`
          )) === null)
      ) {
        return this.failed("before_dispatch", "authorization_revoked", false);
      }
      if (credentialRef !== undefined) {
        credentials = this.credentials(
          context.registration,
          context.operation,
          runId,
          effect.stateId,
          input.claim
        );
      }
    }
    const compiled = compileTool(
      context.registration,
      context.operation,
      configurationOf(configuration),
      runtimeManifest
    );
    if (compiled === undefined) {
      return this.failed("before_dispatch", "oim_compile_failed", false);
    }
    const fileIds =
      "multipart" in compiled.binding || "mime" in compiled.binding
        ? extractOimMultipartFileIds(compiled.binding, intent.arguments)
        : [];
    const prepared = this.prepared(
      context.authority,
      context.contract,
      compiled,
      context.registration.manifest,
      configuration,
      fileIds
    );
    if (
      prepared.kind !== "ready" ||
      prepared.destination !== effect.intent.destination ||
      prepared.adapter.ref !== context.contract.spec.adapter.ref ||
      prepared.configurationDigest !== intent.configurationDigest ||
      canonicalHash(fileIds) !== canonicalHash(intent.fileIds ?? [])
    ) {
      return this.failed("before_dispatch", "adapter_binding_mismatch", false);
    }
    if (fileIds.length > 0) {
      if (this.options.fileAuthorizer === undefined) {
        return this.failed("before_dispatch", "file_authorizer_missing", false);
      }
      try {
        await this.options.fileAuthorizer.assertAuthorized({
          authority: context.authority,
          bundle: context.bundle,
          contract: context.contract,
          stateKey: effect.stateId,
          fileIds,
        });
      } catch {
        return this.failed("before_dispatch", "file_access_denied", false);
      }
    }

    try {
      const runner = hookRunnerFor(
        context.registration,
        this.options.businessId,
        context.bundle.digest,
        this.options.hookExecutor
      );
      const fileReadAuthorization: OimFileReadAuthorizationPort | undefined =
        this.options.fileAuthorizer === undefined
          ? undefined
          : {
              assertAuthorized: async ({ fileIds: currentFileIds }) => {
                if (canonicalHash(currentFileIds) !== canonicalHash(intent.fileIds ?? [])) {
                  throw new Error("file_binding_mismatch");
                }
                if (
                  !(await this.claimCurrent({
                    runId,
                    stateKey: effect.stateId,
                    claim: input.claim,
                  }))
                ) {
                  throw new Error("run_claim_lost");
                }
                await this.options.fileAuthorizer?.assertAuthorized({
                  authority: context.authority,
                  bundle: context.bundle,
                  contract: context.contract,
                  stateKey: effect.stateId,
                  fileIds: currentFileIds,
                });
              },
            };
      const adapter = adapterOf(
        compiled,
        this.options,
        runtimeManifest,
        runner,
        fileReadAuthorization
      );
      const request = await validateAndShapeRequest(
        {
          intent: effect.intent,
          idempotencyKey: effect.idempotencyKey,
          attempt: input.attempt,
        },
        context.contract,
        context.operation,
        context.registration.manifest,
        runner
      );
      if (
        !(await this.claimCurrent({
          runId,
          stateKey: effect.stateId,
          claim: input.claim,
        }))
      ) {
        return this.failed("before_dispatch", "run_claim_lost", false);
      }
      const integration = this.options.releaseIntegration(context.registration.manifest);
      if (integration === undefined) {
        return this.failed("before_dispatch", "oim_release_not_active", false);
      }
      let settlement: OimDispatchSettlement = "not_dispatched";
      const output = await this.options.releaseDispatch.dispatch(
        { businessId: this.options.businessId, integration },
        async (providerDispatch) => {
          try {
            const result = await providerDispatch(() =>
              credentials === undefined
                ? adapter.dispatch(request)
                : credentials.dispatch(effect, adapter, request)
            );
            settlement = "settled";
            if (!ajv.compile(context.contract.spec.outputSchema)(result)) {
              throw new AdapterDispatchError("after_dispatch", "invalid_output", false);
            }
            return result;
          } catch (error) {
            settlement =
              error instanceof AdapterDispatchError
                ? error.phase === "before_dispatch"
                  ? "not_dispatched"
                  : context.contract.spec.mutating
                    ? "ambiguous"
                    : "settled"
                : "ambiguous";
            throw error;
          }
        },
        async () => settlement
      );
      return { kind: "succeeded", output };
    } catch (error) {
      if (!(error instanceof AdapterDispatchError)) throw error;
      return this.failed(
        error.phase,
        error.code,
        error.retryable,
        error.providerRequestId,
        error.retryAfterMs
      );
    }
  }

  private async context(
    runId: string,
    state: {
      readonly stateKey: string;
      readonly action?: string;
      readonly claim: RoutineOimClaimEvidence;
    }
  ) {
    const claimed = await this.options.runs.claim({
      businessId: this.options.businessId,
      runId,
      stateKey: state.stateKey,
      claim: state.claim,
    });
    if (claimed === undefined) {
      return { kind: "failed" as const, reason: "run_claim_lost" };
    }
    const { authority } = claimed;
    if (
      authority.businessId !== this.options.businessId ||
      authority.runId !== runId ||
      claimed.state.key !== state.stateKey ||
      claimed.bundle.digest !== authority.bundleDigest
    ) {
      return { kind: "failed" as const, reason: "run_claim_lost" };
    }
    if (authority.source !== "routine" || authority.routineId === undefined) {
      return { kind: "failed" as const, reason: "not_a_routine" };
    }
    const bundle = await this.options.bundles.load(this.options.businessId, authority.bundleDigest);
    if (bundle === undefined || bundle.businessId !== this.options.businessId) {
      return { kind: "unavailable" as const, reason: "pinned_bundle_unavailable" };
    }
    const routineState = routineToolState(bundle, authority, claimed.bundle, claimed.state, state);
    if (routineState === undefined) {
      return { kind: "failed" as const, reason: "routine_state_mismatch" };
    }
    const toolId = routineState.toolRef.name;
    const toolVersion = routineState.toolRef.version;
    const found = toolContract(bundle, toolId, toolVersion);
    if (found === undefined) return { kind: "failed" as const, reason: "unknown_contract" };
    if (!found.contract.spec.adapter.ref.startsWith("oim-")) {
      return { kind: "unmanaged" as const };
    }
    const registration = await this.options.registrations.find({
      businessId: this.options.businessId,
      bundleDigest: bundle.digest,
      contractId: found.definition.id,
      contractHash: found.definition.hash,
    });
    if (registration === undefined) {
      return { kind: "unavailable" as const, reason: "oim_registration_unavailable" };
    }
    const operation = operationFor(registration, toolId);
    if (operation === undefined || registration.manifest.metadata.version !== toolVersion) {
      return { kind: "failed" as const, reason: "oim_operation_mismatch" };
    }
    return {
      kind: "ready" as const,
      authority,
      bundle,
      definition: found.definition,
      contract: found.contract,
      registration,
      operation,
    };
  }

  private prepared(
    authority: RunAuthority,
    contract: ToolContractDefinition,
    compiled: CompiledRoutineOimTool,
    manifest: OimManifest,
    configuration: Readonly<Record<string, string | number | boolean>>,
    fileIds: readonly string[]
  ): RoutineOimPreparationResult {
    if (
      compiled.contract.spec.toolId !== contract.spec.toolId ||
      compiled.contract.spec.toolVersion !== contract.spec.toolVersion ||
      compiled.contract.spec.action !== contract.spec.action ||
      compiled.contract.spec.adapter.kind !== contract.spec.adapter.kind ||
      compiled.adapterRef !== contract.spec.adapter.ref
    ) {
      return { kind: "unavailable", reason: "adapter_binding_mismatch" };
    }
    const producesBinaryFile =
      "binaryResponse" in compiled.binding && compiled.binding.binaryResponse === true;
    return {
      kind: "ready",
      adapter: contract.spec.adapter,
      destination: destinationOf(compiled),
      ...(fileIds.length === 0 ? {} : { fileIds }),
      ...(!producesBinaryFile && fileIds.length === 0
        ? {}
        : { filePrincipalId: authority.subject.id }),
      ...(authority.agent?.principalId === undefined
        ? {}
        : { agentPrincipalId: authority.agent.principalId }),
      integrationId: manifest.metadata.id,
      integrationMajorVersion: oimManifestMajor(manifest),
      operationId: compiled.operation.id,
      manifestDigest: canonicalHash(manifest),
      configurationDigest: canonicalHash(configuration),
    };
  }

  private credentials(
    registration: RoutineOimRegistration,
    operation: OimOperation,
    runId: string,
    stateKey: string,
    claim: RoutineOimClaimEvidence
  ): CredentialDispatcher {
    const manifest = registration.manifest;
    const authorizer: SecretAuthorizer = {
      authorize: async (scope) =>
        (await this.claimCurrent({ runId, stateKey, claim })) &&
        (await this.connectionScopeAuthorized(registration, operation, scope))
          ? { allowed: true, maxTtlMs: 5 * 60 * 1000, maxUses: 1 }
          : { allowed: false, reason: "not_authorized" },
    };
    const provider: SecretProvider = {
      resolveCurrent: async (key) => (await this.options.secrets()).resolveCurrent(key),
      resolveUncached: async (key) =>
        (await secretsServiceProvider(await this.options.secrets()).resolveUncached?.(key)) ?? null,
      currentVersion: async (key) =>
        (await secretsServiceProvider(await this.options.secrets()).currentVersion?.(key)) ?? null,
    };
    return new CredentialDispatcher({
      secrets: new SecretBroker({
        provider,
        authorizer,
      }),
      reauthorize: async (effect) => {
        if (!(await this.claimCurrent({ runId, stateKey, claim }))) return false;
        const connection = effect.intent.connection;
        const credentialRef = effect.intent.credentialRef;
        if (connection === undefined || credentialRef === undefined) return false;
        const live = await this.options.connections.reauthorizeConnection(
          effect.businessId,
          manifest,
          operation,
          connection,
          credentialRef as `secret://${string}`
        );
        if (live === null) {
          return false;
        }
        const secondaryConnection = effect.intent.secondaryConnection;
        const secondaryCredentialRef = effect.intent.secondaryCredentialRef;
        if (
          !(
            (secondaryConnection === undefined && secondaryCredentialRef === undefined) ||
            (secondaryConnection !== undefined &&
              secondaryCredentialRef !== undefined &&
              (await this.options.connections.reauthorizeConnection(
                effect.businessId,
                manifest,
                operation,
                secondaryConnection,
                secondaryCredentialRef as `secret://${string}`
              )) !== null)
          )
        ) {
          return false;
        }
        const compiled = compileTool(registration, operation, live.configuration, manifest);
        return (
          compiled !== undefined &&
          destinationOf(compiled) === effect.intent.destination &&
          canonicalHash(live.configuration) === effect.intent.configurationDigest
        );
      },
    });
  }

  private async claimCurrent(input: {
    readonly runId: string;
    readonly stateKey: string;
    readonly claim: RoutineOimClaimEvidence;
  }): Promise<boolean> {
    return (
      (await this.options.runs.claim({
        businessId: this.options.businessId,
        runId: input.runId,
        stateKey: input.stateKey,
        claim: input.claim,
      })) !== undefined
    );
  }

  private async connectionScopeAuthorized(
    registration: RoutineOimRegistration,
    operation: OimOperation,
    scope: import("@tulipfarm/secrets").SecretScope
  ): Promise<boolean> {
    const manifest = registration.manifest;
    if (
      scope.businessId === undefined ||
      scope.connectionId === undefined ||
      scope.credentialSlot === undefined ||
      scope.credentialRevision === undefined ||
      scope.integrationId !== manifest.metadata.id ||
      scope.integrationMajorVersion !== oimManifestMajor(manifest) ||
      scope.operationId !== operation.id ||
      scope.identityMode !== operation.identityMode ||
      scope.manifestDigest !== canonicalHash(manifest) ||
      scope.configurationDigest === undefined ||
      scope.principalKind === undefined ||
      scope.principalId === undefined ||
      scope.destination === undefined ||
      !scope.secretRef.startsWith("secret://")
    ) {
      return false;
    }
    const live = await this.options.connections.reauthorizeConnection(
      scope.businessId,
      manifest,
      operation,
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
      scope.secretRef as `secret://${string}`
    );
    if (live === null) return false;
    const compiled = compileTool(registration, operation, live.configuration, manifest);
    return compiled !== undefined && destinationOf(compiled) === scope.destination;
  }

  private failed(
    phase: "before_dispatch" | "after_dispatch",
    code: string,
    retryable: boolean,
    providerRequestId?: string,
    retryAfterMs?: number
  ): RoutineOimDispatchResult {
    return {
      kind: "failed",
      error: {
        phase,
        code,
        retryable,
        ...(providerRequestId === undefined ? {} : { providerRequestId }),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
    };
  }
}
