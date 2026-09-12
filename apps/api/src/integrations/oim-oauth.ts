import type { OimOAuthRefresh, OimOAuthRefreshRequest } from "@tulipfarm/integrations";
import type { OimAuth, OimManifest } from "@tulipfarm/schema";
import type { AuthOAuth2Step, AuthStep, IntegrationManifest } from "@tulipfarm/soul";
import { AuthBrokerError, refreshOAuth2Credentials } from "./auth-broker";

/**
 * Running an OIM package's OAuth 2.0 step through the auth broker that already exists.
 *
 * The broker owns PKCE, one-use state, token exchange and refresh. None of that is worth a second
 * implementation, so an OIM `oauth2` step is *translated* into the legacy `AuthStep` the broker
 * runs. What differs is only where the values come from and where they land: a legacy flow reads
 * and writes `connection.yaml` env, while an OIM flow reads the Connection's credential slots and
 * writes back into them.
 *
 * The bridge between the two is a stable, derived env name per credential slot. An author never
 * writes one and never sees one.
 */

export type OimOAuth2Step = Extract<OimAuth["steps"][number], { type: "oauth2" }>;
type BrokerOAuth2Step = AuthOAuth2Step & {
  readonly client_secret_optional?: boolean;
  readonly token_endpoint_auth_method?: "none" | "client_secret_post" | "client_secret_basic";
};

const HOST_OWNED_AUTHORIZATION_PARAMETERS: ReadonlySet<string> = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "scope",
  "code_challenge",
  "code_challenge_method",
]);

function oimAuthorizationUrl(authorizationUrl: string): string {
  const url = new URL(authorizationUrl);
  for (const parameter of HOST_OWNED_AUTHORIZATION_PARAMETERS) {
    url.searchParams.delete(parameter);
  }
  return url.toString();
}

function oimAuthorizationParameters(
  parameters: Readonly<Record<string, string>> | undefined
): Record<string, string> | undefined {
  if (parameters === undefined) return undefined;
  const safe = Object.fromEntries(
    Object.entries(parameters).filter(
      ([parameter]) => !HOST_OWNED_AUTHORIZATION_PARAMETERS.has(parameter)
    )
  );
  return Object.keys(safe).length === 0 ? undefined : safe;
}

/** The env name the broker uses for one OIM credential slot. Derived, never authored. */
export function oimSlotEnv(slot: string): string {
  return `OIM_${slot.toUpperCase()}`;
}

/** The broker env name for one non-secret Connection configuration field. */
export function oimConfigurationEnv(field: string): string {
  return `OIM_CONFIG_${field.toUpperCase()}`;
}

type OimTarget = OimAuth["steps"][number] extends infer Step
  ? Step extends { bindings: readonly (infer Binding)[] }
    ? Binding extends { target: infer Target }
      ? Target
      : never
    : never
  : never;

function targetEnv(target: OimTarget): string {
  return target.type === "credential" ? oimSlotEnv(target.slot) : oimConfigurationEnv(target.field);
}

/** The slot an env name came from, or undefined when the broker minted a name of its own. */
export function oimEnvSlot(env: string, manifest: OimManifest): string | undefined {
  return (manifest.auth?.credentialSlots ?? []).find((s) => oimSlotEnv(s.id) === env)?.id;
}

function oimEnvConfiguration(env: string, manifest: OimManifest): string | undefined {
  return (manifest.auth?.configurationFields ?? []).find(
    (field) => oimConfigurationEnv(field.id) === env
  )?.id;
}

/** The first `oauth2` step a package declares, or undefined when it needs no consent flow. */
export function oimOAuthStep(manifest: OimManifest): OimOAuth2Step | undefined {
  return (manifest.auth?.steps ?? []).find((step): step is OimOAuth2Step => step.type === "oauth2");
}

/**
 * The slot each token-response field lands in.
 *
 * Only credential targets are returned: a configuration binding is a value the Connection already
 * holds in the clear, and the broker deals exclusively in sealed env.
 */
function bindingSlot(step: OimOAuth2Step, sourcePath: string): string | undefined {
  const binding = step.bindings.find((candidate) => candidate.sourcePath === sourcePath);
  return binding?.target.type === "credential" ? binding.target.slot : undefined;
}

/**
 * The legacy manifest the broker executes for one OIM package.
 *
 * Step 0 is the `fields` step holding the operator's own client id and secret — the package names
 * the provider's URLs and scopes, never an app. Step 1 is the OAuth step, so callers can address it
 * by a fixed index rather than searching.
 *
 * `personal: true` is set from the caller's scope rather than the manifest: the same Google package
 * connects a shared workspace account and a person's own mailbox, and only the connect request
 * knows which one is being made.
 */
export function oimOAuthLegacyManifest(
  manifest: OimManifest,
  options: { readonly personal?: boolean } = {}
): IntegrationManifest | undefined {
  const step = oimOAuthStep(manifest);
  if (step === undefined) return undefined;

  const accessSlot = bindingSlot(step, "/access_token");
  if (accessSlot === undefined) return undefined;
  const refreshSlot = bindingSlot(step, "/refresh_token");
  const clientIdEnv = oimSlotEnv(step.clientId.slot);
  const clientSecretEnv = oimSlotEnv(step.clientSecret?.slot ?? `${step.clientId.slot}_secret`);
  const authorizationParameters = oimAuthorizationParameters(step.authorizationParameters);

  const oauth2: BrokerOAuth2Step = {
    kind: "oauth2",
    title: step.title,
    grant: "authorization_code",
    authorization_url: oimAuthorizationUrl(step.authorizationUrl),
    token_url: step.tokenUrl,
    scopes: [...step.scopes],
    ...(authorizationParameters === undefined ? {} : { authorize_params: authorizationParameters }),
    client_id_env: clientIdEnv,
    client_secret_env: clientSecretEnv,
    ...(step.clientSecret === undefined ? { client_secret_optional: true } : {}),
    ...(step.tokenEndpointAuthMethod === undefined
      ? {}
      : { token_endpoint_auth_method: step.tokenEndpointAuthMethod }),
    token_env: oimSlotEnv(accessSlot),
    ...(step.description === undefined ? {} : { description: step.description }),
    ...(step.pkce === undefined ? {} : { pkce: step.pkce }),
    ...(options.personal === true ? { personal: true } : {}),
    ...(refreshSlot === undefined ? {} : { refresh_token_env: oimSlotEnv(refreshSlot) }),
    // Every other binding is a value the provider returns alongside the token — a workspace id, an
    // account id — that later operations template into their paths.
    map: Object.fromEntries(
      step.bindings
        .filter(
          (binding) =>
            binding.target.type === "credential" &&
            binding.sourcePath !== "/access_token" &&
            binding.sourcePath !== "/refresh_token"
        )
        .map((binding) => [
          binding.sourcePath.slice(1).replaceAll("/", "."),
          oimSlotEnv((binding.target as { slot: string }).slot),
        ])
    ),
  };

  return {
    name: manifest.metadata.id,
    description: manifest.metadata.description,
    auth: [
      {
        kind: "fields",
        title: "Your OAuth app",
        fields: [
          { name: clientIdEnv, description: "OAuth client id", secret: false },
          { name: clientSecretEnv, description: "OAuth client secret", secret: true },
        ],
      },
      oauth2,
    ],
  } as unknown as IntegrationManifest;
}

/** The index of the OAuth step inside the derived manifest. Fixed by `oimOAuthLegacyManifest`. */
export const OIM_OAUTH_STEP_INDEX = 1;

type BrokerStep = AuthStep & {
  readonly oim_step_id?: string;
  readonly oim_capture?: Readonly<Record<string, string>>;
  readonly client_secret_optional?: boolean;
  readonly token_endpoint_auth_method?: "none" | "client_secret_post" | "client_secret_basic";
};

function pointerName(path: string): string {
  return path.slice(1).replaceAll("~1", "/").replaceAll("~0", "~");
}

function withState(url: string): string {
  const parsed = new URL(url);
  const sentinel = "tulipfarm_oim_state_placeholder";
  parsed.searchParams.set("state", sentinel);
  return parsed.toString().replace(`state=${sentinel}`, "state={state}");
}

/** Translates every browser-mediated OIM step into the existing trusted auth broker contract. */
export function oimAuthLegacyManifest(
  manifest: OimManifest,
  options: { readonly personal?: boolean } = {}
): IntegrationManifest {
  const steps: BrokerStep[] = [];
  for (const step of manifest.auth?.steps ?? []) {
    switch (step.type) {
      case "fields":
        steps.push({
          kind: "fields",
          title: step.title,
          ...(step.description === undefined ? {} : { description: step.description }),
          fields: step.fields.map((field) => ({
            name:
              field.target.type === "credential"
                ? oimSlotEnv(field.target.slot)
                : oimConfigurationEnv(field.target.field),
            label: field.label,
            ...(field.description === undefined ? {} : { description: field.description }),
            secret: field.target.type === "credential",
          })),
          oim_step_id: step.id,
        });
        break;
      case "oauth2": {
        const accessBinding = step.bindings.find(
          (binding) => binding.sourcePath === "/access_token"
        );
        if (accessBinding === undefined || accessBinding.target.type !== "credential") break;
        const refreshBinding = step.bindings.find(
          (binding) => binding.sourcePath === "/refresh_token"
        );
        const authorizationParameters = oimAuthorizationParameters(step.authorizationParameters);
        steps.push({
          kind: "oauth2",
          title: step.title,
          ...(step.description === undefined ? {} : { description: step.description }),
          grant: "authorization_code",
          authorization_url: oimAuthorizationUrl(step.authorizationUrl),
          token_url: step.tokenUrl,
          scopes: [...step.scopes],
          ...(authorizationParameters === undefined
            ? {}
            : { authorize_params: authorizationParameters }),
          client_id_env: oimSlotEnv(step.clientId.slot),
          client_secret_env: oimSlotEnv(step.clientSecret?.slot ?? `${step.clientId.slot}_secret`),
          ...(step.clientSecret === undefined ? { client_secret_optional: true } : {}),
          ...(step.tokenEndpointAuthMethod === undefined
            ? {}
            : { token_endpoint_auth_method: step.tokenEndpointAuthMethod }),
          token_env: targetEnv(accessBinding.target),
          ...(step.pkce === undefined ? {} : { pkce: step.pkce }),
          ...(options.personal === true ? { personal: true } : {}),
          ...(refreshBinding?.target.type === "credential"
            ? { refresh_token_env: oimSlotEnv(refreshBinding.target.slot) }
            : {}),
          map: Object.fromEntries(
            step.bindings
              .filter(
                (binding) =>
                  binding.sourcePath !== "/access_token" && binding.sourcePath !== "/refresh_token"
              )
              .map((binding) => [
                pointerName(binding.sourcePath).replaceAll("/", "."),
                targetEnv(binding.target),
              ])
          ),
          oim_step_id: step.id,
        });
        break;
      }
      case "app_manifest":
        steps.push({
          kind: "app_manifest",
          title: step.title,
          ...(step.description === undefined ? {} : { description: step.description }),
          create_url: withState(step.createUrl),
          delivery: "form_post",
          manifest_param: "manifest",
          manifest: step.manifest,
          oim_capture: Object.fromEntries(
            step.bindings.map((binding) => [
              pointerName(binding.sourcePath),
              targetEnv(binding.target),
            ])
          ),
          oim_step_id: step.id,
        });
        break;
      case "install":
        steps.push({
          kind: "install",
          title: step.title,
          ...(step.description === undefined ? {} : { description: step.description }),
          url: withState(step.url),
          capture: Object.fromEntries(
            step.bindings.map((binding) => [
              pointerName(binding.sourcePath),
              targetEnv(binding.target),
            ])
          ),
          oim_step_id: step.id,
        });
        break;
      case "webhook":
        break;
    }
  }
  return {
    name: manifest.metadata.id,
    description: manifest.metadata.description,
    auth: steps,
  } as unknown as IntegrationManifest;
}

/** The broker step index for an OIM step id. */
export function oimLegacyStepIndex(manifest: IntegrationManifest, stepId: string): number {
  return (manifest.auth ?? []).findIndex((step) => (step as BrokerStep).oim_step_id === stepId);
}

/**
 * Turns the env the broker produced back into credential slot values plus an absolute expiry.
 *
 * The expiry is returned separately because it is not a credential: it belongs on the Connection
 * row, where a renewal sweep can find it without unsealing anything.
 */
export function oimCredentialsFromEnv(
  manifest: OimManifest,
  env: Record<string, string>
): { readonly slots: Record<string, string>; readonly expiresAt: string | null } {
  const { slots, expiresAt } = oimConnectionPatchFromEnv(manifest, env);
  return { slots, expiresAt };
}

/** Splits broker output back into the Connection's sealed and safe configuration planes. */
export function oimConnectionPatchFromEnv(
  manifest: OimManifest,
  env: Record<string, string>
): {
  readonly slots: Record<string, string>;
  readonly configuration: Record<string, string>;
  readonly expiresAt: string | null;
} {
  const slots: Record<string, string> = {};
  const configuration: Record<string, string> = {};
  let expiresAt: string | null = null;
  for (const [name, value] of Object.entries(env)) {
    const slot = oimEnvSlot(name, manifest);
    if (slot !== undefined) {
      slots[slot] = value;
      continue;
    }
    const field = oimEnvConfiguration(name, manifest);
    if (field !== undefined) {
      configuration[field] = value;
      continue;
    }
    // The broker derives this name from `token_env`; it is the one value it writes that no slot
    // claims, and reading it back is cheaper than making every package declare a slot for it.
    if (name.endsWith("_EXPIRES_AT")) expiresAt = value;
  }
  return { slots, configuration, expiresAt };
}

/** Adapts one exact OIM OAuth step to the broker's provider refresh implementation. */
export async function refreshOimOAuthStep(
  request: OimOAuthRefreshRequest,
  options: {
    readonly verifyIdentity: (input: {
      readonly request: OimOAuthRefreshRequest;
      readonly credentialValues: Readonly<Record<string, string>>;
      readonly configuration: Readonly<Record<string, string>>;
    }) => Promise<OimOAuthRefresh["verifiedIdentity"] | null>;
    readonly fetchImpl?: typeof globalThis.fetch;
    readonly now?: Date;
  }
): Promise<OimOAuthRefresh> {
  const translated = oimAuthLegacyManifest(request.manifest);
  const stepIndex = oimLegacyStepIndex(translated, request.step.id);
  const brokerStep = stepIndex === undefined ? undefined : translated.auth?.[stepIndex];
  if (brokerStep?.kind !== "oauth2") throw new Error(`unknown OAuth step: ${request.step.id}`);

  const env: Record<string, string> = {};
  for (const [slot, value] of Object.entries(request.credentials)) env[oimSlotEnv(slot)] = value;
  for (const [field, value] of Object.entries(request.connection.configuration)) {
    env[oimConfigurationEnv(field)] = String(value);
  }
  const refreshed = await refreshOAuth2Credentials(brokerStep, env, options);
  const patch = oimConnectionPatchFromEnv(request.manifest, refreshed);
  const outputSlots = new Set(
    request.step.bindings.flatMap((binding) =>
      binding.target.type === "credential" ? [binding.target.slot] : []
    )
  );
  const credentialValues = Object.fromEntries(
    Object.entries(patch.slots).filter(([slot]) => outputSlots.has(slot))
  );
  const verifiedIdentity = await options.verifyIdentity({
    request,
    credentialValues,
    configuration: patch.configuration,
  });
  if (verifiedIdentity === null) {
    throw new AuthBrokerError("exchange_failed", "provider identity could not be verified");
  }
  return {
    credentialValues,
    expiresAt: patch.expiresAt,
    verifiedIdentity,
  };
}
