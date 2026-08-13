import type { SoulIntegration, SoulLoader } from "@tulipfarm/soul";
import { isPersonalCredentialStep, resolveAuthSteps } from "@tulipfarm/soul";
import type { ToolCredentialMode } from "@tulipfarm/tool-broker";
import type { PrincipalProviderTokenRepo } from "../integrations/principal-tokens";

/**
 * Which credential a Tool call spends (D7).
 *
 * The point is not bookkeeping. A provider's own ACLs are the only thing that can decide whether
 * *this person* may touch *that repository or document*, and we cannot reproduce them. Spending a
 * single business-wide bot credential makes every caller look identical to the provider, so those
 * ACLs stop protecting anything: HR and engineering reach the same repos because GitHub sees one
 * actor. Acting as the human is what puts the provider's decision back in the path.
 *
 * The table this implements:
 *
 * | mode             | human-triggered                            | unattended        |
 * | ---------------- | ------------------------------------------ | ----------------- |
 * | `service`        | service                                    | service           |
 * | `user_preferred` | personal if the provider can issue one      | service           |
 * | `user`           | personal, else **refuse** with a prompt     | **refuse**        |
 *
 * The `user_preferred` row is the subtle one. "Preferred" cannot be allowed to mean "never" for
 * everyone who has not connected — that is exactly the silent downgrade to the bot D7 forbids. So
 * it refuses too, but *only where the provider can actually issue a personal credential*. A
 * provider whose manifest declares no authorization-code step (GitHub App installs, today) has no
 * personal credential to offer, so refusing would deny the Tool forever with no way to recover.
 * There the service credential is the honest answer, and it becomes a refusal the moment such a
 * step is declared.
 */

export type CredentialResolution =
  /** Spend the deployment's shared credential. */
  | { readonly use: "service" }
  /** Spend this principal's own credential, sealed under `principal.<kind>.<id>.<provider>.*`. */
  | {
      readonly use: "principal";
      readonly principal: { readonly kind: string; readonly id: string };
    }
  /** The call may not proceed; `reason` is written for the model and the person reading the turn. */
  | { readonly use: "denied"; readonly reason: string };

export interface CredentialSubject {
  readonly kind: string;
  readonly id: string;
}

export interface CredentialResolverDeps {
  readonly tokens: PrincipalProviderTokenRepo;
  readonly soulLoader?: SoulLoader;
}

/**
 * Whether this integration's declared connect flow can mint a credential for one person.
 *
 * The discriminator is the step's explicit `personal: true`, **not** its grant type. OAuth2 says
 * how a token was obtained and nothing about whose access it carries: Slack's "Install to your
 * workspace" step is `authorization_code` and returns a workspace *bot* token with bot scopes.
 * Inferring "personal" from the grant would seal that shared token under one person's name and
 * attribute the bot's entire reach to them in the audit trail, while every Tool acting "as the
 * human" would in fact act as the bot — the confused deputy this layer exists to close, reached
 * through the connect flow rather than around it.
 *
 * Undeclared therefore means "not personal", so a manifest that has not thought about the question
 * cannot answer it by accident. This is the same test `startAuthStep` applies before issuing a
 * user-scoped state, stated once so the refusal and the flow cannot disagree — a Tool that refuses
 * a call for want of a credential the connect route would not issue is a dead end.
 */
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
