import {
  compileOimGraphqlOperations,
  compileOimHttpOperations,
  DEFAULT_OIM_PAGINATION_BOUNDS,
  type EgressHttpPort,
  evaluateOimAuthVerification,
  NEXT_PAGE_TOKEN_PROPERTY,
  type OimConnectionVerificationEvidence,
  OimGraphqlToolAdapter,
  type OimHookPhaseRunner,
  OimHttpToolAdapter,
  type OimPaginationRuntime,
  PAGE_TOKEN_ARGUMENT,
  type ResolvedOimPackage,
} from "@tulipfarm/integrations";
import {
  canonicalHash,
  type OimAuth,
  type OimManifest,
  oimFileDigest,
  oimPackageDigest,
} from "@tulipfarm/schema";
import type { ConnectionAuthStep, PersistedConnection } from "@tulipfarm/storage";
import type { ToolAdapterRequest } from "@tulipfarm/tool-broker";

interface AuthStepReader {
  list(businessId: string, connectionId: string): Promise<readonly ConnectionAuthStep[]>;
}

interface CredentialReader {
  read(reference: string): Promise<string>;
}

export interface OimVerificationHostDeps {
  readonly authSteps: AuthStepReader;
  readonly credentials: CredentialReader;
  readonly http: EgressHttpPort;
  readonly paginationRuntime: OimPaginationRuntime;
  readonly hookRunner?: OimHookPhaseRunner;
  readonly now?: () => Date;
}

export interface VerifyOimConnectionInput {
  readonly package: ResolvedOimPackage;
  readonly connection: PersistedConnection;
}

export interface VerifyOimConnectionCandidateInput extends VerifyOimConnectionInput {
  readonly authSteps: readonly ConnectionAuthStep[];
  readonly credentialValues: Readonly<Record<string, string>>;
}

export interface OimVerificationHost {
  verify(input: VerifyOimConnectionInput): Promise<OimConnectionVerificationEvidence>;
  verifyCandidate(
    input: VerifyOimConnectionCandidateInput
  ): Promise<OimConnectionVerificationEvidence>;
}

function credentialTargets(step: OimAuth["steps"][number]): readonly string[] {
  switch (step.type) {
    case "fields":
      return step.fields.flatMap((field) =>
        field.target.type === "credential" ? [field.target.slot] : []
      );
    case "oauth2":
    case "jwt_assertion":
    case "app_manifest":
    case "install":
      return step.bindings.flatMap((binding) =>
        binding.target.type === "credential" ? [binding.target.slot] : []
      );
    case "webhook":
      return [step.secretSlot];
  }
}

function slotSteps(manifest: OimManifest): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const step of manifest.auth?.steps ?? []) {
    for (const slot of credentialTargets(step)) {
      const existing = result.get(slot);
      if (existing !== undefined && existing !== step.id) {
        throw new Error(`verification_credential_step_ambiguous:${slot}`);
      }
      result.set(slot, step.id);
    }
  }
  return result;
}

function pointerValue(value: unknown, pointer: string): unknown {
  let current = value;
  for (const encodedSegment of pointer.slice(1).split("/")) {
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function request(
  businessId: string,
  connectionId: string,
  packageKey: string,
  operationId: string,
  toolVersion: string,
  credentialRef: string | undefined,
  argumentsValue: Readonly<Record<string, unknown>>
): ToolAdapterRequest {
  const intentId = `oim-verification:${connectionId}:${operationId}`;
  return {
    intent: {
      intentId,
      businessId,
      runId: intentId,
      stateId: operationId,
      toolId: `oim.${packageKey}.${operationId}`,
      toolVersion,
      action: `integration.${packageKey}.verify`,
      targetRefs: [],
      arguments: argumentsValue,
      idempotencyKey: intentId,
      ...(credentialRef === undefined ? {} : { credentialRef }),
    },
    idempotencyKey: intentId,
    attempt: 1,
  };
}

async function dispatchVerificationOperation(input: {
  readonly deps: OimVerificationHostDeps;
  readonly pkg: ResolvedOimPackage;
  readonly connection: PersistedConnection;
  readonly operationId: string;
  readonly credentialValues: Readonly<Record<string, string>>;
}): Promise<unknown> {
  const operation = input.pkg.manifest.operations.find(
    (candidate) => candidate.id === input.operationId
  );
  if (
    operation === undefined ||
    operation.effect !== "read" ||
    (operation.source.type !== "graphql" &&
      (operation.source.type !== "http" || operation.source.method !== "GET"))
  ) {
    throw new Error(`verification_operation_unavailable:${input.operationId}`);
  }
  const manifest = { ...input.pkg.manifest, operations: [operation] };
  if (operation.source.type === "graphql") {
    const path = operation.source.documentFile;
    const file = input.pkg.manifest.files?.find((candidate) => candidate.path === path);
    const document = input.pkg.documents?.[path];
    if (
      file?.role !== "graphql" ||
      document === undefined ||
      oimFileDigest(document) !== file.sha256 ||
      oimPackageDigest(input.pkg.manifest) !== input.pkg.packageDigest
    ) {
      throw new Error(`verification_document_invalid:${operation.id}`);
    }
  }
  const compiled =
    operation.source.type === "graphql"
      ? compileOimGraphqlOperations(
          manifest,
          new Map(Object.entries(input.pkg.documents ?? {})),
          input.connection.configuration
        )[0]
      : compileOimHttpOperations(manifest, input.connection.configuration)[0];
  if (compiled === undefined) throw new Error(`verification_operation_unavailable:${operation.id}`);
  const adapterDeps = {
    http: input.deps.http,
    manifest: input.pkg.manifest,
    ...(input.deps.hookRunner === undefined ? {} : { hookRunner: input.deps.hookRunner }),
    ...(operation.pagination === undefined
      ? {}
      : {
          pagination: operation.pagination,
          paginationRuntime: input.deps.paginationRuntime,
          toolId: compiled.contract.metadata.id,
        }),
  };
  const adapter =
    "document" in compiled.binding
      ? new OimGraphqlToolAdapter({
          ...adapterDeps,
          binding: compiled.binding,
          ...("projection" in operation.response && operation.response.projection !== undefined
            ? { projection: operation.response.projection }
            : {}),
        })
      : new OimHttpToolAdapter({ ...adapterDeps, binding: compiled.binding });
  const primaryRef =
    operation.credentialSlot === undefined
      ? undefined
      : input.connection.secretBindings[operation.credentialSlot];
  const primary =
    operation.credentialSlot === undefined
      ? undefined
      : input.credentialValues[operation.credentialSlot];
  const send = (argumentsValue: Readonly<Record<string, unknown>>) =>
    adapter.dispatch(
      request(
        input.connection.businessId,
        input.connection.id,
        input.pkg.key,
        operation.id,
        input.pkg.manifest.metadata.version,
        primaryRef,
        argumentsValue
      ),
      primary,
      input.credentialValues
    );
  const first = await send({});
  if (operation.pagination === undefined) return first;
  if (typeof first !== "object" || first === null) {
    throw new Error(`verification_pagination_invalid:${operation.id}`);
  }

  const combined = structuredClone(first) as Record<string, unknown>;
  const itemsPath = operation.pagination.itemsPath ?? "/items";
  const items = pointerValue(combined, itemsPath);
  if (!Array.isArray(items)) throw new Error(`verification_pagination_invalid:${operation.id}`);
  let token = combined[NEXT_PAGE_TOKEN_PROPERTY];
  delete combined[NEXT_PAGE_TOKEN_PROPERTY];
  let pages = 1;
  while (typeof token === "string") {
    if (pages >= DEFAULT_OIM_PAGINATION_BOUNDS.maxPages) {
      throw new Error(`verification_pagination_bound_exceeded:${operation.id}`);
    }
    const page = await send({ [PAGE_TOKEN_ARGUMENT]: token });
    if (typeof page !== "object" || page === null) {
      throw new Error(`verification_pagination_invalid:${operation.id}`);
    }
    const pageItems = pointerValue(page, itemsPath);
    if (!Array.isArray(pageItems)) {
      throw new Error(`verification_pagination_invalid:${operation.id}`);
    }
    items.push(...pageItems);
    token = (page as Record<string, unknown>)[NEXT_PAGE_TOKEN_PROPERTY];
    pages += 1;
  }
  return combined;
}

export function createOimVerificationHost(deps: OimVerificationHostDeps): OimVerificationHost {
  async function verifyCandidate({
    package: pkg,
    connection,
    authSteps: rows,
    credentialValues,
  }: VerifyOimConnectionCandidateInput): Promise<OimConnectionVerificationEvidence> {
    const verification = pkg.manifest.auth?.verification;
    if (verification === undefined) throw new Error("verification_not_declared");
    if (
      connection.integration.id !== pkg.identity.id ||
      connection.integration.majorVersion !== pkg.identity.majorVersion
    ) {
      throw new Error("verification_package_mismatch");
    }

    const byStep = new Map(rows.map((row) => [row.stepId, row]));
    const owningStep = slotSteps(pkg.manifest);
    const clientIdSlot =
      verification.evidence.assurance === "identified" &&
      verification.evidence.subject.namespace === "issuer_client"
        ? verification.evidence.subject.clientIdSlot
        : undefined;
    const requiredSlots = [
      ...new Set([
        ...verification.checks.flatMap((check) => check.credentialSlots),
        ...(clientIdSlot === undefined ? [] : [clientIdSlot]),
      ]),
    ];
    const bindingSteps = new Map<
      string,
      {
        stepId: string;
        revision: number;
        credentials: { slot: string; referenceDigest: string }[];
      }
    >();

    for (const slot of requiredSlots) {
      const stepId = owningStep.get(slot);
      const row = stepId === undefined ? undefined : byStep.get(stepId);
      const reference = connection.secretBindings[slot];
      if (
        stepId === undefined ||
        row === undefined ||
        row.status !== "active" ||
        row.businessId !== connection.businessId ||
        row.connectionId !== connection.id
      ) {
        throw new Error(`verification_auth_step_inactive:${slot}`);
      }
      if (reference === undefined) throw new Error(`verification_credential_missing:${slot}`);
      if (credentialValues[slot] === undefined) {
        throw new Error(`verification_credential_value_missing:${slot}`);
      }
      const step = bindingSteps.get(stepId) ?? {
        stepId,
        revision: row.revision,
        credentials: [],
      };
      step.credentials.push({
        slot,
        referenceDigest: canonicalHash(reference),
        ...(slot === clientIdSlot ? { valueDigest: canonicalHash(credentialValues[slot]) } : {}),
      });
      bindingSteps.set(stepId, step);
    }

    const binding = {
      businessId: connection.businessId,
      connectionId: connection.id,
      integrationId: connection.integration.id,
      integrationMajorVersion: connection.integration.majorVersion,
      packageDigest: pkg.packageDigest,
      configurationDigest: canonicalHash(connection.configuration),
      authSteps: [...bindingSteps.values()]
        .map((step) => ({
          ...step,
          credentials: step.credentials.sort((left, right) => left.slot.localeCompare(right.slot)),
        }))
        .sort((left, right) => left.stepId.localeCompare(right.stepId)),
    };
    const now = (deps.now ?? (() => new Date()))();

    const responses: Record<string, unknown> = {};
    for (const check of verification.checks) {
      const operation = pkg.manifest.operations.find(({ id }) => id === check.operationId);
      const slots = [
        ...(operation?.credentialSlot === undefined ? [] : [operation.credentialSlot]),
        ...(operation?.secondaryCredential === undefined
          ? []
          : [operation.secondaryCredential.slot]),
      ].sort();
      if (canonicalHash(slots) !== canonicalHash([...check.credentialSlots].sort())) {
        throw new Error(`verification_credential_slots_mismatch:${check.id}`);
      }
      responses[check.id] = await dispatchVerificationOperation({
        deps,
        pkg,
        connection,
        operationId: check.operationId,
        credentialValues,
      });
    }
    return evaluateOimAuthVerification({
      verification,
      configuration: connection.configuration,
      responses,
      binding,
      verifiedAt: now.toISOString(),
    });
  }

  return {
    async verify({ package: pkg, connection }) {
      const rows = await deps.authSteps.list(connection.businessId, connection.id);
      const requiredSlots = [
        ...new Set(
          [
            ...(pkg.manifest.auth?.verification?.checks ?? []).flatMap(
              (check) => check.credentialSlots
            ),
            ...(pkg.manifest.auth?.verification?.evidence.assurance === "identified" &&
            pkg.manifest.auth.verification.evidence.subject.namespace === "issuer_client"
              ? [pkg.manifest.auth.verification.evidence.subject.clientIdSlot]
              : []),
          ].filter((slot): slot is string => slot !== undefined)
        ),
      ];
      const credentialValues: Record<string, string> = {};
      for (const slot of requiredSlots) {
        const reference = connection.secretBindings[slot];
        if (reference === undefined) throw new Error(`verification_credential_missing:${slot}`);
        credentialValues[slot] = await deps.credentials.read(reference);
      }
      return verifyCandidate({ package: pkg, connection, authSteps: rows, credentialValues });
    },
    verifyCandidate,
  };
}
