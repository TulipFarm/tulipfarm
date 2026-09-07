import {
  type AuthorityLayer,
  compileRoutineAuthority,
  decideEffectivePermission,
} from "@tulipfarm/authz";
import {
  type CompiledOimGraphqlTool,
  type CompiledOimHttpTool,
  type CompiledOimOpenApiTool,
  compileOimGraphqlOperations,
  compileOimHttpOperations,
  compileOimOpenApiOperations,
  type EgressHttpPort,
  type OimFilePort,
  OimGraphqlToolAdapter,
  type OimHookPhaseRunner,
  OimHttpToolAdapter,
  type OimOperationConnectionResolver,
  type OimReleasePackage,
  runOimHookPhase,
} from "@tulipfarm/integrations";
import {
  canonicalHash,
  compileJsonSchema,
  type OimManifest,
  type OimOperation,
  type OimPackageContent,
  oimOriginPlaceholder,
  oimToolId,
  type routine,
  type ToolContractDefinition,
} from "@tulipfarm/schema";
import {
  type SecretAuthorizer,
  SecretBroker,
  type SecretsService,
  secretsServiceProvider,
} from "@tulipfarm/secrets";
import {
  type BundleStore,
  type BundleVerifier,
  type RuntimeBundle,
  verifyExecutionBundle,
} from "@tulipfarm/soul";
import {
  AdapterDispatchError,
  CredentialDispatcher,
  deriveContractTargets,
  type EffectRecord,
  type EffectStore,
  publishToolContract,
  type ToolAdapter,
  type ToolAdapterRequest,
  ToolTargetDerivationError,
  type ToolTargetRef,
} from "@tulipfarm/tool-broker";
import {
  type AuthorityPrincipal,
  type LiveAuthorityLayerResolver,
  principalKindOf,
} from "@tulipfarm/tool-host";
import {
  type ConnectionOriginApprovalRepository,
  ConnectionOriginPolicyError,
  manifestForApprovedConnectionOrigin,
  oimConnectionOriginRequiresApproval,
} from "../integrations/connection-origin-policy";
import { type ExecuteVerifiedOimHookDeps, executeVerifiedOimHook } from "../integrations/oim-hooks";
import type { RunAuthority } from "./turn-host";

export interface RoutineOimRegistration {
  readonly manifest: OimManifest;
  readonly documents?: Readonly<Record<string, string>>;
  readonly openApiDocuments?: Readonly<Record<string, unknown>>;
  readonly packageFiles?: Readonly<Record<string, OimPackageContent>>;
  readonly signedRelease?: unknown;
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

export interface RoutineOimRunAuthority {
  authority(businessId: string, runId: string): Promise<RunAuthority>;
}

export interface RoutineOimLiveAuthorizer {
  authorize(input: {
    readonly authority: RunAuthority;
    readonly bundle: RuntimeBundle;
    readonly contract: ToolContractDefinition;
    readonly effect: EffectRecord;
  }): Promise<boolean>;
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
    readonly effect: EffectRecord;
  }): Promise<boolean> {
    const { authority, contract, effect } = input;
    if (
      authority.businessId !== effect.businessId ||
      authority.runId !== effect.runId ||
      effect.intent.businessId !== effect.businessId ||
      effect.intent.runId !== effect.runId ||
      effect.intent.action !== contract.spec.action
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
    const routine: AuthorityLayer = {
      name: `routine:${authority.routineId ?? "unknown"}`,
      grants: compileRoutineAuthority([contract]),
    };
    const actions =
      contract.spec.requiredActions && contract.spec.requiredActions.length > 0
        ? contract.spec.requiredActions
        : [effect.intent.action];
    const targets =
      effect.intent.targetRefs.length > 0
        ? effect.intent.targetRefs
        : (contract.spec.requiredResources ?? []).map((type) => ({ type }));
    const protectedTargets =
      targets.length > 0
        ? targets
        : [{ type: "Tool", id: contract.spec.toolId as string | undefined }];
    return actions.every((action) =>
      protectedTargets.every(
        (target) =>
          decideEffectivePermission([caller, routine], {
            action,
            resourceType: target.type,
            recordId: "id" in target ? target.id : undefined,
            ...("domain" in target && target.domain !== undefined ? { domain: target.domain } : {}),
            ...(contract.spec.dataClasses?.[0] === undefined
              ? {}
              : { dataClass: contract.spec.dataClasses[0] }),
            ...(effect.intent.destination === undefined
              ? {}
              : { destination: effect.intent.destination }),
          }).allowed
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

type CompiledRoutineOimTool = CompiledOimHttpTool | CompiledOimOpenApiTool | CompiledOimGraphqlTool;

export interface InternalRoutineOimToolHostOptions {
  readonly businessId: string;
  readonly runs: RoutineOimRunAuthority;
  readonly bundles: RoutineOimBundleReader;
  readonly registrations: RoutineOimRegistrationReader;
  readonly connections: OimOperationConnectionResolver;
  readonly originApprovals?: ConnectionOriginApprovalRepository;
  readonly effects: Pick<EffectStore, "get" | "listAttempts">;
  readonly secrets: () => Promise<SecretsService>;
  readonly http: EgressHttpPort;
  readonly authorize: RoutineOimLiveAuthorizer;
  readonly hooks?: ExecuteVerifiedOimHookDeps;
  readonly files?: OimFilePort;
  /** Adds durable quota/cooldown policy without moving provider execution out of this host. */
  readonly decorateAdapter?: (
    adapter: ToolAdapter,
    manifest: OimManifest,
    operation: OimOperation
  ) => ToolAdapter;
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
  input: {
    readonly stateKey: string;
    readonly action?: string;
  }
): Extract<routine.RoutineState, { readonly type: "tool" }> | undefined {
  if (authority.routineId === undefined) return undefined;
  const definition = bundle.getById(authority.routineId);
  if (definition?.kind !== "Routine") return undefined;
  const routineDefinition = definition.document as unknown as routine.RoutineDefinition;
  const matchesStateKey = (name: string) =>
    input.stateKey === name || input.stateKey.endsWith(`/${name}`);
  const states = routineDefinition.spec.states.filter(
    (state): state is Extract<routine.RoutineState, { readonly type: "tool" }> =>
      state.type === "tool" &&
      matchesStateKey(state.name) &&
      (input.action === undefined || state.action === input.action)
  );
  return states.length === 1 ? states[0] : undefined;
}

function configurationOf(
  value: Readonly<Record<string, string | number | boolean>>
): Readonly<Record<string, string | number | boolean>> {
  return value;
}

function compileTool(
  registration: RoutineOimRegistration,
  operation: OimOperation,
  configuration: Readonly<Record<string, string | number | boolean>>,
  manifest: OimManifest = registration.manifest
): CompiledRoutineOimTool | undefined {
  const operationManifest = { ...manifest, operations: [operation] };
  switch (operation.source.type) {
    case "http":
      return compileOimHttpOperations(operationManifest, configuration)[0];
    case "openapi":
      return compileOimOpenApiOperations(
        operationManifest,
        new Map(Object.entries(registration.openApiDocuments ?? {})),
        configuration
      )[0];
    case "graphql":
      return compileOimGraphqlOperations(
        operationManifest,
        new Map(Object.entries(registration.documents ?? {}))
      )[0];
  }
}

function originConfigurationField(operation: OimOperation): string | undefined {
  if (
    (operation.source.type !== "http" && operation.source.type !== "openapi") ||
    operation.source.baseUrl === undefined
  ) {
    return undefined;
  }
  return oimOriginPlaceholder(operation.source.baseUrl);
}

async function manifestForConnectionOrigin(
  options: InternalRoutineOimToolHostOptions,
  manifest: OimManifest,
  operation: OimOperation,
  connection: Parameters<typeof manifestForApprovedConnectionOrigin>[0]["connection"]
): Promise<OimManifest> {
  const field = originConfigurationField(operation);
  if (field === undefined || !oimConnectionOriginRequiresApproval(manifest, field)) {
    return manifest;
  }
  const approval = await options.originApprovals?.get(options.businessId, connection.id, field);
  if (approval === undefined || approval === null) {
    throw new ConnectionOriginPolicyError("approval_missing");
  }
  return manifestForApprovedConnectionOrigin({ manifest, connection, approval });
}

function destinationOf(tool: CompiledRoutineOimTool): string {
  return new URL("baseUrl" in tool.binding ? tool.binding.baseUrl : tool.binding.url).host;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function hookRunner(
  registration: RoutineOimRegistration,
  hooks: ExecuteVerifiedOimHookDeps | undefined
): OimHookPhaseRunner | undefined {
  if (hooks === undefined) return undefined;
  const package_: OimReleasePackage = {
    manifest: registration.manifest,
    files: new Map(Object.entries(registration.packageFiles ?? {})),
  };
  return {
    run: (hook, value) =>
      executeVerifiedOimHook(hooks, {
        package: package_,
        ...(registration.signedRelease === undefined
          ? {}
          : { signedRelease: registration.signedRelease }),
        hook,
        value,
      }),
  };
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
      compileJsonSchema(contract.spec.inputSchema)(shaped.value) !== null
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
  options: Pick<InternalRoutineOimToolHostOptions, "http" | "files" | "decorateAdapter">,
  manifest: OimManifest,
  runner: OimHookPhaseRunner | undefined
): ToolAdapter {
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
        : { pagination: tool.pagination }),
      ...(options.files === undefined ? {} : { files: options.files }),
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
    }
  ): Promise<RoutineOimPreparationResult> {
    const context = await this.context(runId, { stateKey: input.stateKey });
    if (context.kind !== "ready") return context;
    const { authority, contract, registration, operation } = context;
    if (operation.credentialSlot === undefined) {
      const compiled = compileTool(registration, operation, {});
      if (compiled === undefined) return { kind: "unavailable", reason: "oim_compile_failed" };
      return this.prepared(authority, contract, compiled);
    }
    if (input.connectionId === undefined) {
      return { kind: "failed", reason: "connection_required" };
    }
    const resolved = await this.options.connections.resolve({
      businessId: this.options.businessId,
      manifest: registration.manifest,
      operation,
      principal: authority.subject,
      ...(authority.subject.kind === "user" ? { personalOwnerId: authority.subject.id } : {}),
      connectionId: input.connectionId,
      requireExplicitConnection: true,
    });
    if (resolved.kind !== "ready") {
      return {
        kind: "failed",
        reason:
          resolved.kind === "connection_denied" ? `connection_${resolved.reason}` : resolved.kind,
      };
    }
    let runtimeManifest: OimManifest;
    try {
      runtimeManifest = await manifestForConnectionOrigin(
        this.options,
        registration.manifest,
        operation,
        resolved.connection
      );
    } catch (error) {
      if (error instanceof ConnectionOriginPolicyError) {
        return { kind: "failed", reason: "action_required" };
      }
      throw error;
    }
    const compiled = compileTool(
      registration,
      operation,
      configurationOf(resolved.connection.configuration),
      runtimeManifest
    );
    if (compiled === undefined) return { kind: "unavailable", reason: "oim_compile_failed" };
    const ready = this.prepared(authority, contract, compiled);
    if (ready.kind !== "ready") return ready;
    return {
      ...ready,
      credentialRef: resolved.credentialRef,
      connection: resolved.binding,
      ...(resolved.secondaryCredentialRef === undefined || resolved.secondaryBinding === undefined
        ? {}
        : {
            secondaryCredentialRef: resolved.secondaryCredentialRef,
            secondaryConnection: resolved.secondaryBinding,
          }),
    };
  }

  async dispatch(
    runId: string,
    effectId: string,
    input: { readonly attempt: number }
  ): Promise<RoutineOimDispatchResult> {
    const effect = await this.options.effects.get(this.options.businessId, effectId);
    if (effect === undefined || effect.runId !== runId) {
      return this.failed("before_dispatch", "effect_not_found", false);
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
        effect,
      }))
    ) {
      return this.failed("before_dispatch", "authorization_revoked", false);
    }

    let compiled: CompiledRoutineOimTool | undefined;
    let runtimeManifest = context.registration.manifest;
    let credentials: CredentialDispatcher | undefined;
    if (context.operation.credentialSlot === undefined) {
      if (effect.intent.connection !== undefined || effect.intent.credentialRef !== undefined) {
        return this.failed("before_dispatch", "connection_binding_mismatch", false);
      }
      compiled = compileTool(context.registration, context.operation, {});
    } else {
      const connection = effect.intent.connection;
      const credentialRef = effect.intent.credentialRef;
      if (connection === undefined || credentialRef === undefined) {
        return this.failed("before_dispatch", "connection_required", false);
      }
      if (
        connection.principalKind !== context.authority.subject.kind ||
        connection.principalId !== context.authority.subject.id
      ) {
        return this.failed("before_dispatch", "authorization_revoked", false);
      }
      const currentConnection = await this.options.connections.reauthorizeConnection(
        this.options.businessId,
        context.registration.manifest,
        context.operation,
        connection,
        credentialRef as `secret://${string}`
      );
      if (currentConnection === null) {
        return this.failed("before_dispatch", "authorization_revoked", false);
      }
      try {
        runtimeManifest = await manifestForConnectionOrigin(
          this.options,
          context.registration.manifest,
          context.operation,
          currentConnection
        );
      } catch (error) {
        if (error instanceof ConnectionOriginPolicyError) {
          return this.failed("before_dispatch", "action_required", false);
        }
        throw error;
      }
      const secondaryConnection = effect.intent.secondaryConnection;
      const secondaryCredentialRef = effect.intent.secondaryCredentialRef;
      if (
        (secondaryConnection === undefined) !== (secondaryCredentialRef === undefined) ||
        (secondaryConnection !== undefined &&
          secondaryCredentialRef !== undefined &&
          !(await this.options.connections.reauthorize(
            this.options.businessId,
            context.registration.manifest,
            secondaryConnection,
            secondaryCredentialRef as `secret://${string}`
          )))
      ) {
        return this.failed("before_dispatch", "authorization_revoked", false);
      }
      compiled = compileTool(
        context.registration,
        context.operation,
        configurationOf(currentConnection.configuration),
        runtimeManifest
      );
      credentials = this.credentials(context.registration.manifest);
    }
    if (compiled === undefined) {
      return this.failed("before_dispatch", "oim_compile_failed", false);
    }
    const prepared = this.prepared(context.authority, context.contract, compiled);
    if (
      prepared.kind !== "ready" ||
      prepared.destination !== effect.intent.destination ||
      prepared.adapter.ref !== context.contract.spec.adapter.ref
    ) {
      return this.failed("before_dispatch", "adapter_binding_mismatch", false);
    }

    try {
      const runner = hookRunner(context.registration, this.options.hooks);
      const adapter = adapterOf(compiled, this.options, runtimeManifest, runner);
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
      const output =
        credentials === undefined
          ? await adapter.dispatch(request)
          : await credentials.dispatch(effect, adapter, request);
      if (compileJsonSchema(context.contract.spec.outputSchema)(output) !== null) {
        throw new AdapterDispatchError("after_dispatch", "invalid_output", false);
      }
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
    }
  ) {
    const authority = await this.options.runs.authority(this.options.businessId, runId);
    if (authority.source !== "routine" || authority.routineId === undefined) {
      return { kind: "failed" as const, reason: "not_a_routine" };
    }
    const bundle = await this.options.bundles.load(this.options.businessId, authority.bundleDigest);
    if (bundle === undefined || bundle.businessId !== this.options.businessId) {
      return { kind: "unavailable" as const, reason: "pinned_bundle_unavailable" };
    }
    const routineState = routineToolState(bundle, authority, state);
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
    compiled: CompiledRoutineOimTool
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
    const files =
      compiled.operation.source.type === "http" &&
      (compiled.operation.source.contentType === "multipart" ||
        compiled.operation.response.mode === "binary");
    return {
      kind: "ready",
      adapter: contract.spec.adapter,
      destination: destinationOf(compiled),
      ...(files ? { filePrincipalId: authority.subject.id } : {}),
    };
  }

  private credentials(manifest: OimManifest): CredentialDispatcher {
    const authorizer: SecretAuthorizer = {
      authorize(scope) {
        const connection = scope as {
          readonly connectionId?: string;
          readonly integrationId?: string;
        };
        return connection.connectionId !== undefined &&
          connection.integrationId === manifest.metadata.id
          ? { allowed: true, maxTtlMs: 5 * 60 * 1000, maxUses: 1 }
          : { allowed: false, reason: "not_authorized" };
      },
    };
    return new CredentialDispatcher({
      secrets: new SecretBroker({
        provider: secretsServiceProvider({
          resolveCurrent: async (key) => (await this.options.secrets()).resolveCurrent(key),
          revision: async (key) => (await this.options.secrets()).revision(key),
        }),
        authorizer,
      }),
      reauthorize: async (effect) => {
        const connection = effect.intent.connection;
        const credentialRef = effect.intent.credentialRef;
        if (connection === undefined || credentialRef === undefined) return false;
        if (
          !(await this.options.connections.reauthorize(
            effect.businessId,
            manifest,
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
            (await this.options.connections.reauthorize(
              effect.businessId,
              manifest,
              secondaryConnection,
              secondaryCredentialRef as `secret://${string}`
            )))
        );
      },
    });
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
