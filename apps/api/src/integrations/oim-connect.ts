import { randomBytes, randomUUID } from "node:crypto";
import type { OimAuth, OimConnection, OimManifest } from "@tulipfarm/schema";
import { oimOriginAllowed, oimOriginPlaceholder } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type { ConnectionStore } from "@tulipfarm/storage";

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
    })),
  }));
  const unsupportedStepTypes = [
    ...new Set(
      (auth?.steps ?? [])
        .filter(
          (step) => step.type !== "fields" && step.type !== "oauth2" && step.type !== "webhook"
        )
        .map((s) => s.type)
    ),
  ];
  return {
    integrationId: manifest.metadata.id,
    majorVersion: oimMajorVersion(manifest),
    steps,
    unsupportedStepTypes,
    requiresAuthorization: (auth?.steps ?? []).some((step) => step.type === "oauth2"),
  };
}

/** True when every step the manifest declares is one this runtime can execute today. */
export function oimConnectSupported(manifest: OimManifest): boolean {
  const steps = manifest.auth?.steps ?? [];
  return (
    steps.length > 0 &&
    steps.every(
      (step) => step.type === "fields" || step.type === "oauth2" || step.type === "webhook"
    )
  );
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
    // Only an `http` source carries a templated `baseUrl`; the others pin an absolute URL.
    if (operation.source.type !== "http") continue;
    const placeholder = oimOriginPlaceholder(operation.source.baseUrl);
    if (placeholder !== undefined) fields.add(placeholder);
  }
  return fields;
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
  values: Readonly<Record<string, string>>
): readonly ResolvedField[] {
  const declared = new Map(
    fieldsSteps(manifest.auth).flatMap((step) => step.fields.map((f) => [f.id, f] as const))
  );
  for (const id of Object.keys(values)) {
    if (!declared.has(id)) throw new OimConnectError("unknown_field", id);
  }
  const resolved: ResolvedField[] = [];
  for (const [id, field] of declared) {
    const value = values[id]?.trim() ?? "";
    if (value.length === 0) {
      if (field.required !== false) throw new OimConnectError("missing_field", id);
      continue;
    }
    resolved.push({ field, value });
  }
  return resolved;
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
  const allowedHosts = manifest.auth?.allowedOriginHosts ?? [];

  const configuration: Record<string, string | number | boolean> = {};
  const agentVisible: string[] = [];
  const pending: { readonly slot: string; readonly value: string }[] = [];

  for (const { field, value } of resolved) {
    if (field.target.type === "credential") {
      pending.push({ slot: field.target.slot, value });
      continue;
    }
    const configField = field.target.field;
    // An origin field is stored as the bare host the template interpolates, never as the URL it
    // was pasted from, so the stored value is already the one the compiler will substitute.
    if (origins.has(configField)) {
      const host = resolveHost(field, value);
      if (!oimOriginAllowed(host, allowedHosts)) {
        throw new OimConnectError("origin_not_allowed", host);
      }
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
    if (step.type === "oauth2") {
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
  await deps.connections.put(input.businessId, {
    id: connectionId,
    integration: { id: manifest.metadata.id, majorVersion: oimMajorVersion(manifest) },
    label: input.label,
    owner: input.owner,
    status: "active",
    isDefault: input.isDefault ?? true,
    configuration,
    agentVisibleConfiguration: agentVisible,
    secretBindings,
    health: { status: "unknown", checkedAt: new Date().toISOString() },
    expiresAt: null,
  });
  return { connectionId };
}
