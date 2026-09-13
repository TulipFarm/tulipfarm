import type { ProviderAclEntry } from "./oim-mapping";
import type {
  OimKnowledgeConnectionScope,
  OimKnowledgeExecutionScope,
  OimKnowledgeIdentityPort,
} from "./oim-sync";

export interface OimKnowledgePrincipalRef {
  readonly kind: string;
  readonly id: string;
}

export interface TrustedProviderIdentityLinkPort {
  linkedPrincipal(
    input: OimKnowledgeConnectionScope & {
      readonly provider: string;
      readonly externalTenantId: string;
      readonly providerId: string;
    }
  ): Promise<OimKnowledgePrincipalRef | undefined>;
}

export interface VerifiedEmailPrincipalPort {
  principalForEmail(input: {
    readonly businessId: string;
    readonly email: string;
  }): Promise<OimKnowledgePrincipalRef | undefined>;
}

export interface ProviderAccountPort {
  account(
    input: OimKnowledgeExecutionScope & { readonly providerId: string }
  ): Promise<{ readonly email?: string; readonly emailVerified?: boolean } | undefined>;
  groupMembers(
    input: OimKnowledgeExecutionScope & { readonly groupId: string }
  ): Promise<readonly string[] | undefined>;
}

export interface OimKnowledgeIdentityPolicy {
  readonly verifiedEmailDomains: readonly string[];
}

export interface ResolveOimKnowledgePrincipalsInput extends OimKnowledgeConnectionScope {
  readonly externalTenantId: string;
  readonly externalAccountId: string;
  readonly entries: readonly ProviderAclEntry[];
}

export interface ResolveOimKnowledgePrincipalsDeps {
  readonly links: TrustedProviderIdentityLinkPort;
  readonly emails?: VerifiedEmailPrincipalPort;
  readonly accounts?: ProviderAccountPort;
  readonly policy: OimKnowledgeIdentityPolicy;
}

export function createOimKnowledgeIdentityPort(
  deps: ResolveOimKnowledgePrincipalsDeps
): OimKnowledgeIdentityPort {
  return {
    resolve: (input) => resolveOimKnowledgePrincipals(input, deps),
  };
}

export async function resolveOimKnowledgePrincipals(
  input: ResolveOimKnowledgePrincipalsInput,
  deps: ResolveOimKnowledgePrincipalsDeps
): Promise<{
  readonly principals: readonly OimKnowledgePrincipalRef[];
  readonly incomplete: boolean;
}> {
  const principals: OimKnowledgePrincipalRef[] = [];
  const seen = new Set<string>();
  let incomplete = false;

  const add = (principal: OimKnowledgePrincipalRef | undefined) => {
    if (principal === undefined) return;
    const key = `${principal.kind}:${principal.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    principals.push(principal);
  };
  const addUser = async (providerId: string) => {
    const linked = await deps.links.linkedPrincipal({
      businessId: input.businessId,
      provider: input.integrationId,
      integrationId: input.integrationId,
      integrationMajorVersion: input.integrationMajorVersion,
      connectionId: input.connectionId,
      externalTenantId: input.externalTenantId,
      providerId,
    });
    if (linked !== undefined) {
      add(linked);
      return;
    }
    if (
      deps.accounts === undefined ||
      deps.emails === undefined ||
      deps.policy.verifiedEmailDomains.length === 0
    ) {
      return;
    }
    const account = await deps.accounts.account({
      businessId: input.businessId,
      integrationId: input.integrationId,
      integrationMajorVersion: input.integrationMajorVersion,
      connectionId: input.connectionId,
      externalTenantId: input.externalTenantId,
      externalAccountId: input.externalAccountId,
      providerId,
    });
    if (account?.email === undefined || account.emailVerified !== true) return;
    const email = account.email.toLowerCase();
    const domain = email.split("@")[1];
    if (
      domain === undefined ||
      !deps.policy.verifiedEmailDomains.some((allowed) => allowed.toLowerCase() === domain)
    ) {
      return;
    }
    add(await deps.emails.principalForEmail({ businessId: input.businessId, email }));
  };

  for (const entry of input.entries) {
    if (entry.kind === "public") {
      add({ kind: "role", id: "role-everyone" });
      continue;
    }
    if (entry.id === undefined) continue;
    if (entry.kind === "domain") {
      add({ kind: "domain", id: entry.id.toLowerCase() });
      continue;
    }
    if (entry.kind === "user") {
      await addUser(entry.id);
      continue;
    }
    const members = await deps.accounts?.groupMembers({
      businessId: input.businessId,
      integrationId: input.integrationId,
      integrationMajorVersion: input.integrationMajorVersion,
      connectionId: input.connectionId,
      externalTenantId: input.externalTenantId,
      externalAccountId: input.externalAccountId,
      groupId: entry.id,
    });
    if (members === undefined) {
      incomplete = true;
      continue;
    }
    for (const member of members) await addUser(member);
  }
  return { principals, incomplete };
}
