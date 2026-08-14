import type { SoulIntegration, SoulLoader } from "@tulipfarm/soul";
import { isPersonalCredentialStep, resolveAuthSteps } from "@tulipfarm/soul";
import type { ToolCredentialMode } from "@tulipfarm/tool-broker";
import type { PrincipalProviderTokenRepo } from "../integrations/principal-tokens";

/** Chooses service vs personal credentials; `user_preferred` must not silently downgrade to bot. */

export type CredentialResolution =
  /** Spend the deployment's shared credential. */
  | { readonly use: "service" }
  /** Spend this principal's own credential, sealed under `principal.<kind>.<id>.<provider>.*`. */
  | {
      readonly use: "principal";
      readonly principal: { readonly kind: string; readonly id: string };
    }
  /** The call may not proceed; `reason` is user- and model-facing. */
  | { readonly use: "denied"; readonly reason: string };

export interface CredentialSubject {
  readonly kind: string;
  readonly id: string;
}

export interface CredentialResolverDeps {
  readonly tokens: PrincipalProviderTokenRepo;
  readonly soulLoader?: SoulLoader;
}

/** Personal support is explicit `personal: true`, never inferred from OAuth grant type. */
export function providerSupportsPersonalCredential(integration: SoulIntegration): boolean {
  return resolveAuthSteps(integration.manifest).some(isPersonalCredentialStep);
}

/** A human sat behind this call. Only a `user` principal is a person who could hold a token. */
function isHumanTriggered(subject: CredentialSubject): boolean {
  return subject.kind === "user";
}

function connectPrompt(provider: string, toolName: string): string {
  return `"${toolName}" acts on ${provider} as you, and you have not connected your ${provider} account — connect it from Settings › Integrations, then try again. Do not retry this call until you have.`;
}

export class CredentialResolver {
  constructor(private readonly deps: CredentialResolverDeps) {}

  async resolve(
    subject: CredentialSubject,
    tool: {
      readonly name: string;
      readonly provider?: string;
      readonly credentialMode: ToolCredentialMode;
    }
  ): Promise<CredentialResolution> {
    const provider = tool.provider;
    // No provider means no credential is spent at all — a local effect. There is nothing to scope.
    if (provider === undefined || tool.credentialMode === "service") return { use: "service" };

    const strict = tool.credentialMode === "user";
    if (!isHumanTriggered(subject)) {
      // Unattended work has no person to act as. Under `user` that is a refusal rather than a
      // downgrade: the Tool declared that acting as the bot is not an acceptable substitute, and
      // honouring that is the whole reason the mode is distinguishable from `user_preferred`.
      return strict
        ? {
            use: "denied",
            reason: `"${tool.name}" must act as a specific person on ${provider}, and this call has no person behind it — do not retry this call`,
          }
        : { use: "service" };
    }

    const token = await this.deps.tokens.find({ kind: subject.kind, id: subject.id }, provider);
    if (token !== null)
      return { use: "principal", principal: { kind: subject.kind, id: subject.id } };

    if (strict) return { use: "denied", reason: connectPrompt(provider, tool.name) };

    // `user_preferred`: refuse only where connecting is possible. An unresolvable integration is
    // treated as unable to issue one — the Tool exists, so denying it on a catalog miss would be a
    // refusal the person could do nothing about.
    const integration = this.deps.soulLoader?.integrations.get(provider);
    if (integration !== undefined && providerSupportsPersonalCredential(integration)) {
      return { use: "denied", reason: connectPrompt(provider, tool.name) };
    }
    return { use: "service" };
  }
}
