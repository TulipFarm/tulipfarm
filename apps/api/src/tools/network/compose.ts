import { type AuthorityLayer, decideEffectivePermission } from "@tulipfarm/authz";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  type EgressHttpPort,
  FetchEgressHttp,
  GuardedEgressHttp,
  normalizedPublicUrl,
} from "@tulipfarm/integrations";
import {
  SecretBroker,
  type SecretScope,
  type SecretsService,
  secretsServiceProvider,
} from "@tulipfarm/secrets";
import type { SoulLoader } from "@tulipfarm/soul";
import { type CachePort, MemoryCache } from "@tulipfarm/storage";
import { type ToolDef, toToolDef } from "@tulipfarm/tool-host";
import type { AuthorityPrincipal } from "../../identity/authority-layers";
import { createNetworkBudget } from "./budget";
import { NETWORK_TOOLS } from "./tools";

export interface NetworkToolingDeps {
  readonly secrets: SecretsService;
  readonly soulLoader: SoulLoader;
  readonly authorityLayers: {
    resolvePrincipalLayer(name: string, principal: AuthorityPrincipal): Promise<AuthorityLayer>;
  };
  readonly http?: EgressHttpPort;
  readonly cache?: CachePort;
}

/** Read a frontmatter list defensively; authored YAML is untyped until it is checked. */
export function declaredStringList(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

function skillAllows(scope: SecretScope, soulLoader: SoulLoader): boolean {
  if (scope.activeSkillName === undefined) return true;
  const skill = soulLoader.skills.get(scope.activeSkillName);
  if (skill === undefined || scope.destination === undefined) return false;
  const secrets = declaredStringList(skill.frontmatter.requiredSecrets);
  const domains = declaredStringList(skill.frontmatter.allowedDomains);
  return (
    secrets.includes(scope.secretRef) &&
    domains.includes(normalizedPublicUrl(scope.destination).host)
  );
}

export function composeNetworkTools(deps: NetworkToolingDeps): readonly ToolDef[] {
  const http = deps.http ?? new GuardedEgressHttp(new FetchEgressHttp());
  // One budget across both Tools: an Agent that has exhausted `web_fetch` must not simply switch
  // to `api_request` and keep going against the same destination.
  const budget = createNetworkBudget();
  // One cache for the deployment, not one per call: the point is that a second read of the same
  // page finds the first one.
  const cache = deps.cache ?? new MemoryCache();
  const broker = new SecretBroker({
    provider: secretsServiceProvider(deps.secrets),
    authorizer: {
      async authorize(scope) {
        if (
          scope.principalKind !== "user" ||
          scope.principalId === undefined ||
          scope.destination === undefined ||
          !skillAllows(scope, deps.soulLoader)
        ) {
          return { allowed: false, reason: "not_authorized" };
        }
        const caller = await deps.authorityLayers.resolvePrincipalLayer("user", {
          kind: "user",
          id: scope.principalId,
          businessId: DEPLOYMENT_BUSINESS_ID,
        });
        const allowed = decideEffectivePermission([caller], {
          action: "secret.use",
          resourceType: "secret",
          recordId: scope.secretRef,
          destination: scope.destination,
        }).allowed;
        return allowed
          ? { allowed: true, maxTtlMs: 60_000, maxUses: 1 }
          : { allowed: false, reason: "not_authorized" };
      },
    },
  });

  return NETWORK_TOOLS.map((definition) =>
    toToolDef(definition, (context) => ({
      userId: context.userId,
      runId: context.runId ?? "",
      ...(context.activeSkillName === undefined
        ? {}
        : { activeSkillName: context.activeSkillName }),
      http,
      cache,
      ...(context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal }),
      spendBudget: () => budget.spend(context.runId ?? ""),
      assertSkillDestination: (destination) => {
        if (context.activeSkillName === undefined) return;
        const skill = deps.soulLoader.skills.get(context.activeSkillName);
        // An active Skill that cannot be resolved is denied: its declarations are unreadable, so
        // there is nothing to intersect against and no safe reading of what it meant to permit.
        if (skill === undefined) {
          throw new Error("The active Skill does not declare this destination");
        }
        // `allowedDomains` confines a Skill that opts into it; it does not conjure an empty
        // allowlist for one that never mentioned the network. Reading absence as deny-all made
        // loading any unrelated Skill silently revoke the Agent's ability to read a public URL.
        // Credentialed calls stay fail-closed regardless — see `skillAllows`.
        const domains = declaredStringList(skill.frontmatter.allowedDomains);
        if (domains.length === 0) return;
        if (!domains.includes(normalizedPublicUrl(destination).host)) {
          throw new Error("The active Skill does not declare this destination");
        }
      },
      useCredential: async (input, callback) => {
        if (input.runId.length === 0) throw new Error("Credential use requires a durable Run");
        const scope: SecretScope = {
          secretRef: input.secret,
          toolId: "api_request",
          runId: input.runId,
          purpose: "governed_api_request",
          principalKind: "user",
          principalId: input.userId,
          destination: input.destination,
          ...(input.activeSkillName === undefined
            ? {}
            : { activeSkillName: input.activeSkillName }),
        };
        const lease = await broker.lease({ scope, maxUses: 1 });
        return lease.use(callback, scope);
      },
    }))
  );
}
