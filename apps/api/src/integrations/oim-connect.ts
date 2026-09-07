import { randomBytes, randomUUID } from "node:crypto";
import type { OimAuth, OimConnection, OimManifest } from "@tulipfarm/schema";
import { oimOriginAllowed, oimOriginPlaceholder } from "@tulipfarm/schema";
import type { ConnectionSecretManager, SecretsService } from "@tulipfarm/secrets";
import { secretStorageKey } from "@tulipfarm/secrets";
import type { ConnectionStore } from "@tulipfarm/storage";
import {
  type ConnectionOriginApprovalRepository,
  ConnectionOriginPolicyError,
  canonicalApprovedPublicOrigin,
  oimConnectionOriginRequiresApproval,
} from "./connection-origin-policy";

/**
 * Connecting an installed OIM package.
 *
 * The manifest already describes everything a person must supply — `auth.steps` names the fields,
 * and each field names the Credential slot or configuration field it lands in. So the connect form
 * is *derived*, never written twice: a package that adds a field gets the input for free, and a
 * package that renames a slot cannot leave a form pointing at the old one.
 */

/** One input on the derived form. `secret` marks a value the API must never read back. */
export interface OimConnectField {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly input: "text" | "password" | "url";
  readonly required: boolean;
  readonly secret: boolean;
  readonly requiresOriginApproval?: boolean;
}

export interface OimConnectStep {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly fields: readonly OimConnectField[];
}

export interface OimConnectForm {
  readonly integrationId: string;
  readonly majorVersion: number;
  readonly steps: readonly OimConnectStep[];
  readonly authorizationSteps: readonly {
    readonly id: string;
    readonly type: "oauth2" | "app_manifest" | "install";
    readonly title: string;
    readonly description?: string;
  }[];
  /** Step types present in the manifest that this runtime cannot yet execute. */
  readonly unsupportedStepTypes: readonly string[];
  /**
   * True when creating the Connection is only half the flow: the person must then be sent to the
   * provider's consent screen. The form still collects their own OAuth client id and secret, which
   * is what the redirect is signed with.
   */
  readonly requiresAuthorization: boolean;
}

export class OimConnectError extends Error {
  constructor(
    readonly code:
      | "unsupported_auth"
      | "unknown_field"
      | "missing_field"
      | "invalid_value"
      | "origin_not_allowed",
    readonly detail?: string
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = "OimConnectError";
  }
}

export function oimMajorVersion(manifest: OimManifest): number {
  return Number(manifest.metadata.version.split(".", 1)[0]);
}

type FieldsStep = Extract<OimAuth["steps"][number], { type: "fields" }>;

function fieldsSteps(auth: OimAuth | undefined): readonly FieldsStep[] {
  return (auth?.steps ?? []).filter((step): step is FieldsStep => step.type === "fields");
}

/**
 * The form a person fills in to connect a package.
 *
 * `required` defaults to true: an optional credential the manifest forgot to mark is a Connection
 * that presents itself as complete and fails at the first dispatch, which is the worse failure.
 */
export function oimConnectForm(manifest: OimManifest): OimConnectForm {
  const auth = manifest.auth;
  const steps = fieldsSteps(auth).map((step) => ({
    id: step.id,
    title: step.title,
    ...(step.description === undefined ? {} : { description: step.description }),
    fields: step.fields.map((field) => ({
      id: field.id,
      label: field.label,
      ...(field.description === undefined ? {} : { description: field.description }),
      input: field.input,
      required: field.required !== false,
      secret: field.target.type === "credential",
      ...(field.target.type === "configuration" &&
      oimConnectionOriginRequiresApproval(manifest, field.target.field)
        ? { requiresOriginApproval: true }
        : {}),
    })),
  }));
  const unsupportedStepTypes = [
    ...new Set(
      (auth?.steps ?? []).filter((step) => !SUPPORTED_AUTH_STEPS.has(step.type)).map((s) => s.type)
    ),
  ];
  const authorizationSteps = (auth?.steps ?? []).flatMap((step) =>
    step.type === "oauth2" || step.type === "app_manifest" || step.type === "install"
      ? [
          {
            id: step.id,
            type: step.type,
            title: step.title,
            ...(step.description === undefined ? {} : { description: step.description }),
          },
        ]
      : []
  );
  return {
    integrationId: manifest.metadata.id,
    majorVersion: oimMajorVersion(manifest),
    steps,
    authorizationSteps,
    unsupportedStepTypes,
    requiresAuthorization: authorizationSteps.length > 0,
  };
}

const SUPPORTED_AUTH_STEPS = new Set(["fields", "oauth2", "app_manifest", "install", "webhook"]);

/** True when every step the manifest declares is one this runtime can execute today. */
export function oimConnectSupported(manifest: OimManifest): boolean {
  const steps = manifest.auth?.steps ?? [];
  return steps.length > 0 && steps.every((step) => SUPPORTED_AUTH_STEPS.has(step.type));
}

interface ResolvedField {
  readonly field: FieldsStep["fields"][number];
  readonly value: string;
}

/**
 * The hosts a templated `baseUrl` may resolve to, keyed by the configuration field that fills it.
 *
 * Checked here as well as at compile time so a bad host is refused while the person can still see
 * why, instead of surfacing later as a Tool that silently refuses every call.
 */
function originFields(manifest: OimManifest): ReadonlySet<string> {
  const fields = new Set<string>();
  for (const operation of manifest.operations) {
    if (operation.source.type !== "http" && operation.source.type !== "openapi") continue;
    if (operation.source.baseUrl === undefined) continue;
    const placeholder = oimOriginPlaceholder(operation.source.baseUrl);
    if (placeholder !== undefined) fields.add(placeholder);
  }
  return fields;
}

function originPolicyFields(manifest: OimManifest): readonly string[] {
  return [...originFields(manifest)].filter((field) =>
    oimConnectionOriginRequiresApproval(manifest, field)
  );
}

/** Policy-bound configured origins that are outside the package's static reviewed allowlist. */
export function oimConnectionOriginApprovalFields(
  manifest: OimManifest,
  connection: Pick<OimConnection, "configuration">
): readonly string[] {
  const allowedHosts = manifest.auth?.allowedOriginHosts ?? [];
  return originPolicyFields(manifest).filter((field) => {
    const configured = connection.configuration[field];
    return typeof configured === "string" && !oimOriginAllowed(configured, allowedHosts);
  });
}

/** Policy-bound origin fields whose normalized value would change on this Connection. */
export function oimConnectionChangedOriginFields(
  manifest: OimManifest,
  connection: Pick<OimConnection, "configuration">,
  configurationPatch: Readonly<Record<string, string | number | boolean>>
): readonly string[] {
  return originPolicyFields(manifest).filter(
    (field) =>
      configurationPatch[field] !== undefined &&
      configurationPatch[field] !== connection.configuration[field]
  );
}

const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

function assertUrlValue(field: ResolvedField["field"], value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OimConnectError("invalid_value", field.id);
  }
  if (url.protocol !== "https:") throw new OimConnectError("invalid_value", field.id);
}

/**
 * The host a value naming an origin resolves to.
 *
 * Accepts a bare host or a full origin, exactly as `resolveBaseUrl` in the HTTP compiler does —
 * both are what an operator pastes out of a browser, and accepting one here but the other at
 * compile time would produce a Connection that stores fine and fails at the first call.
 */
function resolveHost(field: ResolvedField["field"], value: string): string {
  let host = value;
  if (value.includes("://")) {
    try {
      host = new URL(value).host;
    } catch {
      throw new OimConnectError("invalid_value", field.id);
    }
  }
  if (!HOST_RE.test(host)) throw new OimConnectError("invalid_value", field.id);
  return host;
}

function resolveConnectionOrigin(
  manifest: OimManifest,
  field: ResolvedField["field"],
  value: string
): { readonly host: string; readonly approvalRequired: boolean } {
  const host = resolveHost(field, value);
  if (oimOriginAllowed(host, manifest.auth?.allowedOriginHosts ?? [])) {
    return { host, approvalRequired: false };
  }
  const configurationField = field.target.type === "configuration" ? field.target.field : undefined;
  if (
    configurationField === undefined ||
    !oimConnectionOriginRequiresApproval(manifest, configurationField)
  ) {
    throw new OimConnectError("origin_not_allowed", host);
  }
  try {
    return {
      host: new URL(canonicalApprovedPublicOrigin(value)).host,
      approvalRequired: true,
    };
  } catch (error) {
    if (error instanceof ConnectionOriginPolicyError) {
      throw new OimConnectError("origin_not_allowed", host);
    }
    throw error;
  }
}

function coerceConfiguration(
  manifest: OimManifest,
  field: ResolvedField["field"],
  value: string
): string | number | boolean {
  const target = field.target;
  if (target.type !== "configuration") return value;
  const declared = manifest.auth?.configurationFields?.find((c) => c.id === target.field);
  switch (declared?.type) {
    case "integer": {
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) throw new OimConnectError("invalid_value", field.id);
      return parsed;
    }
    case "boolean": {
      if (value !== "true" && value !== "false") {
        throw new OimConnectError("invalid_value", field.id);
      }
      return value === "true";
    }
    default:
      return value;
  }
}

export interface CreateOimConnectionInput {
  readonly businessId: string;
  readonly manifest: OimManifest;
  readonly label: string;
  readonly owner: OimConnection["owner"];
  /** Raw form values keyed by field id. Never passes through a model. */
  readonly values: Readonly<Record<string, string>>;
  readonly isDefault?: boolean;
}

export interface OimConnectionDeps {
  readonly connections: Pick<ConnectionStore, "put">;
  readonly secrets: SecretsService;
  readonly newId?: () => string;
}

function resolveValues(
  manifest: OimManifest,
  values: Readonly<Record<string, string>>,
  requireAll = true
): readonly ResolvedField[] {
  const declared = new Map(
    fieldsSteps(manifest.auth).flatMap((step) => step.fields.map((f) => [f.id, f] as const))
  );
  for (const id of Object.keys(values)) {
    if (!declared.has(id)) throw new OimConnectError("unknown_field", id);
  }
  const resolved: ResolvedField[] = [];
  for (const [id, field] of declared) {
    if (!requireAll && values[id] === undefined) continue;
    const value = values[id]?.trim() ?? "";
    if (value.length === 0) {
      if (field.required !== false) throw new OimConnectError("missing_field", id);
      continue;
    }
    resolved.push({ field, value });
  }
  return resolved;
}

function targetIsBound(
  connection: Pick<OimConnection, "configuration" | "secretBindings">,
  target: FieldsStep["fields"][number]["target"]
): boolean {
  return target.type === "credential"
    ? connection.secretBindings[target.slot] !== undefined
    : connection.configuration[target.field] !== undefined;
}

/** Validates provider-returned configuration before it can affect a compiled destination. */
export function normalizeOimConfigurationPatch(
  manifest: OimManifest,
  values: Readonly<Record<string, string>>
): Record<string, string | number | boolean> {
  const normalized: Record<string, string | number | boolean> = {};
  const origins = originFields(manifest);
  for (const [id, value] of Object.entries(values)) {
    const declared = manifest.auth?.configurationFields?.find((field) => field.id === id);
    if (declared === undefined) throw new OimConnectError("unknown_field", id);
    const field = {
      id,
      label: declared.label,
      input: declared.type === "url" ? ("url" as const) : ("text" as const),
      target: { type: "configuration" as const, field: id },
    };
    if (origins.has(id)) {
      const { host } = resolveConnectionOrigin(manifest, field, value);
      normalized[id] = host;
      continue;
    }
    if (declared.type === "url") assertUrlValue(field, value);
    normalized[id] = coerceConfiguration(manifest, field, value);
  }
  return normalized;
}

/** Browser-mediated auth is pending until every output declared by those steps is bound. */
export function oimConnectionAuthorizationPending(
  manifest: OimManifest,
  connection: Pick<OimConnection, "configuration" | "secretBindings">
): boolean {
  return (manifest.auth?.steps ?? []).some(
    (step) =>
      (step.type === "oauth2" || step.type === "app_manifest" || step.type === "install") &&
      step.bindings.some((binding) => !targetIsBound(connection, binding.target))
  );
}

/**
 * Creates a Connection for an installed package from a completed connect form.
 *
 * Secrets are written before the Connection, so a crash between the two leaves orphaned Secrets
 * rather than a Connection whose bindings point at nothing: the first is invisible, the second
 * would present itself as usable and fail at dispatch.
 */
export async function createOimConnection(
  deps: OimConnectionDeps,
  input: CreateOimConnectionInput
): Promise<{ readonly connectionId: string }> {
  const { manifest } = input;
  if (!oimConnectSupported(manifest)) {
    throw new OimConnectError(
      "unsupported_auth",
      manifest.auth?.steps.find((step) => step.type !== "fields")?.type ?? "none"
    );
  }
  const resolved = resolveValues(manifest, input.values);
  const origins = originFields(manifest);

  const configuration: Record<string, string | number | boolean> = {};
  const agentVisible: string[] = [];
  const pending: { readonly slot: string; readonly value: string }[] = [];
  let originApprovalRequired = false;

  for (const { field, value } of resolved) {
    if (field.target.type === "credential") {
      pending.push({ slot: field.target.slot, value });
      continue;
    }
    const configField = field.target.field;
    // An origin field is stored as the bare host the template interpolates, never as the URL it
    // was pasted from, so the stored value is already the one the compiler will substitute.
    if (origins.has(configField)) {
      const origin = resolveConnectionOrigin(manifest, field, value);
      const { host } = origin;
      originApprovalRequired ||= origin.approvalRequired;
      configuration[configField] = host;
      if (manifest.auth?.configurationFields?.find((c) => c.id === configField)?.agentVisible) {
        agentVisible.push(configField);
      }
      continue;
    }
    if (field.input === "url") assertUrlValue(field, value);
    configuration[configField] = coerceConfiguration(manifest, field, value);
    const declared = manifest.auth?.configurationFields?.find((c) => c.id === configField);
    if (declared?.agentVisible === true) agentVisible.push(configField);
  }

  const newId = deps.newId ?? (() => randomUUID());
  const bound = new Set(pending.map((p) => p.slot));
  // An OAuth flow fills its slots at the callback, not on this form. Refusing them here would make
  // every OAuth package unconnectable, since no person can paste an access token they have not yet
  // been issued.
  for (const step of manifest.auth?.steps ?? []) {
    if (step.type === "oauth2" || step.type === "app_manifest" || step.type === "install") {
      for (const binding of step.bindings) {
        if (binding.target.type === "credential") bound.add(binding.target.slot);
      }
    }
    if (step.type === "webhook") bound.add(step.secretSlot);
  }
  for (const slot of manifest.auth?.credentialSlots ?? []) {
    // A required slot with no field behind it is a manifest that can only ever produce a
    // Connection that fails at dispatch, so it is refused at connect time instead.
    if (slot.required !== false && !bound.has(slot.id)) {
      throw new OimConnectError("missing_field", slot.id);
    }
  }
  const secretBindings: Record<string, string> = {};
  for (const { slot, value } of pending) {
    const key = `oim-${manifest.metadata.id}-${newId().replace(/-/g, "")}`;
    await deps.secrets.set(key, value);
    secretBindings[slot] = `secret://${key}`;
  }
  for (const step of manifest.auth?.steps ?? []) {
    if (step.type !== "webhook") continue;
    const key = `oim-delivery-${manifest.metadata.id}-${newId().replace(/-/g, "")}`;
    await deps.secrets.set(key, randomBytes(32).toString("base64url"));
    secretBindings[step.secretSlot] = `secret://${key}`;
  }

  const connectionId = newId();
  const connection: OimConnection = {
    id: connectionId,
    integration: { id: manifest.metadata.id, majorVersion: oimMajorVersion(manifest) },
    label: input.label,
    owner: input.owner,
    status: "active",
    isDefault: input.isDefault ?? false,
    configuration,
    agentVisibleConfiguration: agentVisible,
    secretBindings,
    health: { status: "unknown", checkedAt: new Date().toISOString() },
    expiresAt: null,
  };
  await deps.connections.put(input.businessId, {
    ...connection,
    health: {
      ...connection.health,
      status:
        originApprovalRequired || oimConnectionAuthorizationPending(manifest, connection)
          ? "action_required"
          : "unknown",
    },
  });
  return { connectionId };
}

export interface UpdateOimConnectionInput {
  readonly businessId: string;
  readonly manifest: OimManifest;
  readonly connection: OimConnection;
  readonly label?: string;
  readonly values?: Readonly<Record<string, string>>;
  readonly isDefault?: boolean;
}

export interface UpdateOimConnectionDeps extends OimConnectionDeps {
  readonly connectionSecrets: Pick<ConnectionSecretManager, "rotate">;
  readonly originApprovals?: Pick<ConnectionOriginApprovalRepository, "delete">;
}

interface PreparedConnectionUpdate {
  readonly configuration: OimConnection["configuration"];
  readonly agentVisibleConfiguration: readonly string[];
  readonly credentialValues: ReadonlyMap<string, string>;
  readonly changedOriginFields: readonly string[];
  readonly originApprovalRequired: boolean;
}

function prepareOimConnectionUpdate(input: UpdateOimConnectionInput): PreparedConnectionUpdate {
  const resolved = resolveValues(input.manifest, input.values ?? {}, false);
  const origins = originFields(input.manifest);
  const configuration = { ...input.connection.configuration };
  const agentVisible = new Set(input.connection.agentVisibleConfiguration);
  const credentialValues = new Map<string, string>();
  const changedOriginFields = new Set<string>();
  let originApprovalRequired = false;

  for (const { field, value } of resolved) {
    if (field.target.type === "credential") {
      credentialValues.set(field.target.slot, value);
      continue;
    }

    const configField = field.target.field;
    if (origins.has(configField)) {
      const origin = resolveConnectionOrigin(input.manifest, field, value);
      if (
        oimConnectionOriginRequiresApproval(input.manifest, configField) &&
        configuration[configField] !== origin.host
      ) {
        changedOriginFields.add(configField);
      }
      originApprovalRequired ||= origin.approvalRequired;
      configuration[configField] = origin.host;
    } else {
      if (field.input === "url") assertUrlValue(field, value);
      configuration[configField] = coerceConfiguration(input.manifest, field, value);
    }
    const declared = input.manifest.auth?.configurationFields?.find(
      (candidate) => candidate.id === configField
    );
    if (declared?.agentVisible === true) agentVisible.add(configField);
  }

  return {
    configuration,
    agentVisibleConfiguration: [...agentVisible],
    credentialValues,
    changedOriginFields: [...changedOriginFields],
    originApprovalRequired,
  };
}

/** Updates only submitted fields. Existing Secret references remain immutable across rotation. */
export async function updateOimConnection(
  deps: UpdateOimConnectionDeps,
  input: UpdateOimConnectionInput
): Promise<void> {
  const prepared = prepareOimConnectionUpdate(input);
  const secretBindings = { ...input.connection.secretBindings };
  let credentialsChanged = false;

  for (const field of prepared.changedOriginFields) {
    await deps.originApprovals?.delete(input.businessId, input.connection.id, field);
  }
  if (prepared.changedOriginFields.length > 0) {
    for (const [slot, secretRef] of Object.entries(secretBindings)) {
      if (prepared.credentialValues.has(slot)) continue;
      const plaintext = await deps.secrets.get(secretStorageKey(secretRef));
      await deps.connectionSecrets.rotate(secretRef, plaintext);
    }
  }

  for (const [slot, value] of prepared.credentialValues) {
    const existingRef = secretBindings[slot];
    if (existingRef !== undefined) {
      await deps.connectionSecrets.rotate(existingRef, value);
      credentialsChanged = true;
      continue;
    }
    const newId = deps.newId ?? (() => randomUUID());
    const key = `oim-${input.manifest.metadata.id}-${newId().replace(/-/g, "")}`;
    await deps.secrets.set(key, value);
    secretBindings[slot] = `secret://${key}`;
    credentialsChanged = true;
  }

  await deps.connections.put(input.businessId, {
    ...input.connection,
    ...(input.label === undefined ? {} : { label: input.label.trim() }),
    ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
    configuration: prepared.configuration,
    agentVisibleConfiguration: [...prepared.agentVisibleConfiguration],
    secretBindings,
    ...(prepared.originApprovalRequired
      ? {
          health: { status: "action_required", checkedAt: new Date().toISOString() },
          ...(credentialsChanged ? { expiresAt: null } : {}),
        }
      : credentialsChanged || prepared.changedOriginFields.length > 0
        ? {
            health: { status: "unknown", checkedAt: new Date().toISOString() },
            ...(credentialsChanged ? { expiresAt: null } : {}),
          }
        : {}),
  });
}

export interface RebindOimConnectionInput extends UpdateOimConnectionInput {
  readonly owner: OimConnection["owner"];
}

export interface RebindOimConnectionDeps extends Omit<OimConnectionDeps, "connections"> {
  readonly connections: Pick<ConnectionStore, "put" | "markRevoked">;
  readonly connectionSecrets: Pick<ConnectionSecretManager, "revokeConnection">;
  readonly originApprovals?: Pick<ConnectionOriginApprovalRepository, "delete">;
}

/** Moves a Connection to a new owner by minting a new identity and new Secret references. */
export async function rebindOimConnection(
  deps: RebindOimConnectionDeps,
  input: RebindOimConnectionInput
): Promise<{ readonly connectionId: string }> {
  const prepared = prepareOimConnectionUpdate(input);
  const newId = deps.newId ?? (() => randomUUID());
  const connectionId = newId();
  const secretBindings: Record<string, string> = {};
  const createdSecretKeys: string[] = [];

  try {
    for (const field of originPolicyFields(input.manifest)) {
      await deps.originApprovals?.delete(input.businessId, input.connection.id, field);
    }
    for (const [slot, reference] of Object.entries(input.connection.secretBindings)) {
      const value =
        prepared.credentialValues.get(slot) ??
        (await deps.secrets.get(secretStorageKey(reference)));
      const key = `oim-${input.manifest.metadata.id}-${newId().replace(/-/g, "")}`;
      await deps.secrets.set(key, value);
      createdSecretKeys.push(key);
      secretBindings[slot] = `secret://${key}`;
    }
    for (const [slot, value] of prepared.credentialValues) {
      if (secretBindings[slot] !== undefined) continue;
      const key = `oim-${input.manifest.metadata.id}-${newId().replace(/-/g, "")}`;
      await deps.secrets.set(key, value);
      createdSecretKeys.push(key);
      secretBindings[slot] = `secret://${key}`;
    }

    await deps.connections.put(input.businessId, {
      id: connectionId,
      integration: input.connection.integration,
      owner: input.owner,
      label: input.label?.trim() ?? input.connection.label,
      status: input.connection.status,
      isDefault: input.isDefault ?? input.connection.isDefault,
      configuration: prepared.configuration,
      agentVisibleConfiguration: [...prepared.agentVisibleConfiguration],
      secretBindings,
      health:
        oimConnectionOriginApprovalFields(input.manifest, {
          configuration: prepared.configuration,
        }).length > 0
          ? { status: "action_required", checkedAt: new Date().toISOString() }
          : prepared.credentialValues.size > 0
            ? { status: "unknown", checkedAt: new Date().toISOString() }
            : input.connection.health,
      expiresAt: prepared.credentialValues.size > 0 ? null : input.connection.expiresAt,
    });
  } catch (error) {
    for (const key of createdSecretKeys) await deps.secrets.delete(key);
    throw error;
  }

  try {
    await deps.connectionSecrets.revokeConnection(
      input.connection.id,
      input.connection.secretBindings,
      async () => {
        await deps.connections.markRevoked(input.businessId, input.connection.id);
      }
    );
  } catch (error) {
    await deps.connectionSecrets.revokeConnection(connectionId, secretBindings, async () => {
      await deps.connections.markRevoked(input.businessId, connectionId);
    });
    throw error;
  }
  return { connectionId };
}
