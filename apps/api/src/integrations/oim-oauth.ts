import type { OimAuth, OimManifest } from "@tulipfarm/schema";
import type { AuthOAuth2Step, IntegrationManifest } from "@tulipfarm/soul";

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

/** The env name the broker uses for one OIM credential slot. Derived, never authored. */
export function oimSlotEnv(slot: string): string {
  return `OIM_${slot.toUpperCase()}`;
}

/** The slot an env name came from, or undefined when the broker minted a name of its own. */
export function oimEnvSlot(env: string, manifest: OimManifest): string | undefined {
  return (manifest.auth?.credentialSlots ?? []).find((s) => oimSlotEnv(s.id) === env)?.id;
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

  const oauth2: AuthOAuth2Step = {
    kind: "oauth2",
    title: step.title,
    grant: "authorization_code",
    authorization_url: step.authorizationUrl,
    token_url: step.tokenUrl,
    scopes: [...step.scopes],
    client_id_env: clientIdEnv,
    client_secret_env: clientSecretEnv,
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
  const slots: Record<string, string> = {};
  let expiresAt: string | null = null;
  for (const [name, value] of Object.entries(env)) {
    const slot = oimEnvSlot(name, manifest);
    if (slot !== undefined) {
      slots[slot] = value;
      continue;
    }
    // The broker derives this name from `token_env`; it is the one value it writes that no slot
    // claims, and reading it back is cheaper than making every package declare a slot for it.
    if (name.endsWith("_EXPIRES_AT")) expiresAt = value;
  }
  return { slots, expiresAt };
}
