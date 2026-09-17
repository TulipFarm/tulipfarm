import type { OimManifest } from "@tulipfarm/schema";
import type { PersistedConnection, ReplaceConnectionCredentials } from "@tulipfarm/storage";
import type { ConnectionCredentialVault } from "./lifecycle";

export function oimCredentialFieldIssue(
  manifest: OimManifest,
  values: Readonly<Record<string, string>>,
  connection?: PersistedConnection
): string | undefined {
  const fields = (manifest.auth?.steps ?? []).flatMap((step) =>
    step.type === "fields" ? step.fields : []
  );
  for (const [id, value] of Object.entries(values)) {
    if (!fields.some((field) => field.id === id)) return `unknown_field:${id}`;
    if (typeof value !== "string" || !value.trim()) return `invalid_field:${id}`;
  }
  for (const field of fields) {
    const existing =
      field.target.type === "credential"
        ? connection?.secretBindings[field.target.slot]
        : connection?.configuration[field.target.field];
    if (field.required === true && !values[field.id] && existing === undefined) {
      return `missing_field:${field.id}`;
    }
  }
  return undefined;
}

export async function replaceOimCredentialFields(input: {
  manifest: OimManifest;
  connection: PersistedConnection;
  authSteps: ReplaceConnectionCredentials["authSteps"];
  values: Readonly<Record<string, string>>;
  credentials: ConnectionCredentialVault;
  replace: (update: ReplaceConnectionCredentials) => Promise<boolean>;
  now: Date;
}): Promise<boolean> {
  const { manifest, connection, credentials } = input;
  const configuration = { ...connection.configuration };
  const secretBindings = { ...connection.secretBindings };
  const staged: string[] = [];
  let published = false;
  try {
    let changed = false;
    for (const step of manifest.auth?.steps ?? []) {
      if (step.type !== "fields") continue;
      for (const field of step.fields) {
        const value = input.values[field.id];
        if (value === undefined) continue;
        if (field.target.type === "configuration") {
          changed ||= configuration[field.target.field] !== value;
          configuration[field.target.field] = value;
        } else {
          const old = secretBindings[field.target.slot];
          if (old !== undefined && (await credentials.read(old)) === value) continue;
          changed = true;
          const reference = await credentials.create(
            manifest.metadata.id,
            field.target.slot,
            value
          );
          staged.push(reference);
          secretBindings[field.target.slot] = reference;
        }
      }
    }
    // Provider consent can depend on configuration embedded in URLs and callback bindings,
    // not just explicit credential inputs. Reauthorize browser steps after any field change.
    const resetSteps = changed
      ? (manifest.auth?.steps ?? []).filter((step) => step.type !== "fields")
      : [];
    for (const step of resetSteps) {
      const targets = "bindings" in step ? step.bindings.map((binding) => binding.target) : [];
      for (const target of targets) {
        if (target.type === "credential") delete secretBindings[target.slot];
        else delete configuration[target.field];
      }
    }
    published = await input.replace({
      connection,
      authSteps: input.authSteps,
      configuration,
      secretBindings,
      resetStepIds: resetSteps.map((step) => step.id),
      checkedAt: input.now.toISOString(),
      verificationRequired: manifest.auth?.verification !== undefined,
    });
    if (!published) return false;
    const retained = new Set(Object.values(secretBindings));
    await credentials.revokeReferences(
      [...Object.values(connection.secretBindings), ...staged].filter(
        (ref) => !retained.has(ref as `secret://${string}`)
      )
    );
    return true;
  } finally {
    if (!published) await credentials.revokeReferences(staged);
  }
}
