import { arch, platform } from "node:os";
import type { PublicOriginsService } from "@tulipfarm/integrations";
import {
  ProductTelemetryReporter,
  productTelemetryPolicy,
  sanitizeTelemetryUrl,
} from "@tulipfarm/observability";
import type { SoulLoader } from "@tulipfarm/soul";
import {
  type IntegrationStore,
  ProductTelemetryStore,
  type Queryable,
  type TransactionPort,
} from "@tulipfarm/storage";
import type { UserRepo } from "../../auth/users";
import { isGitHubInstalled } from "../../integrations/github-status";
import { readSoulConfig } from "../../setup/soul-config";
import { runningVersion } from "../version";

export interface TelemetryComposition {
  database: Queryable;
  transactions: TransactionPort;
  businessId: string;
  soulLoader: SoulLoader;
  soulPath: string;
  soulRepositoryUrl?(): string | undefined;
  userRepo: UserRepo;
  integrations: IntegrationStore;
  publicOrigins: PublicOriginsService;
  bundledSkillNames(): ReadonlySet<string>;
}

export function composeProductTelemetry(deps: TelemetryComposition): ProductTelemetryReporter {
  const store = new ProductTelemetryStore(deps.database, deps.transactions);
  const policy = productTelemetryPolicy(process.env);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: report text deliberately strips control characters
  const text = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  return new ProductTelemetryReporter({
    store,
    setupComplete: async () => (await readSoulConfig(deps.soulPath)).setupComplete === true,
    production: policy.enabled,
    maxLevel: policy.maxLevel,
    endpoint: process.env.TULIPFARM_TELEMETRY_URL,
    bootstrap: async () => {
      const cfg = await readSoulConfig(deps.soulPath);
      const businessName = text(cfg.businessName ?? "").slice(0, 512);
      const businessWebsite = sanitizeTelemetryUrl(cfg.businessWebsite);
      const instanceUrl = sanitizeTelemetryUrl(deps.publicOrigins.current().webOrigin, true);
      const soulUrl = sanitizeTelemetryUrl(
        cfg.gitRemoteUrl ?? deps.soulRepositoryUrl?.() ?? process.env.SOUL_GIT_REMOTE_URL
      );
      return {
        version: text(runningVersion()).slice(0, 512) || "unknown",
        os: platform(),
        architecture: arch(),
        deployment_method:
          text(process.env.TULIPFARM_DEPLOYMENT_METHOD ?? "unknown").slice(0, 512) || "unknown",
        ...(businessName ? { business_name: businessName } : {}),
        ...(businessWebsite ? { business_website: businessWebsite } : {}),
        ...(instanceUrl ? { instance_url: instanceUrl } : {}),
        ...(soulUrl ? { soul_repository_url: soulUrl } : {}),
      };
    },
    snapshot: async () => {
      const connected = new Set<string>();
      for (const [name, integration] of deps.soulLoader.integrations) {
        if (
          integration.mcp?.enabled === true ||
          ((name === "slack" || name === "github") && integration.connection?.enabled === true)
        )
          connected.add(name);
      }
      if (await isGitHubInstalled({ integrations: deps.integrations, businessId: deps.businessId }))
        connected.add("github");
      else connected.delete("github");

      const providers = [...connected];
      const bundled = deps.bundledSkillNames();
      const userSkills = [...deps.soulLoader.skills.keys()].filter((name) => !bundled.has(name));
      const names = (values: Iterable<string>) =>
        [...new Set([...values].map((name) => text(name).slice(0, 128)).filter(Boolean))].sort();
      return {
        users: await deps.userRepo.count(),
        resource_types: deps.soulLoader.resources.size,
        integrations: providers.length,
        skills: userSkills.length,
        bundled_skills: bundled.size,
        agents: deps.soulLoader.agents.size,
        routines: deps.soulLoader.routines.size,
        resource_type_names: names(deps.soulLoader.resources.keys()),
        integration_providers: names(providers),
        skill_names: names(userSkills),
        agent_names: names(deps.soulLoader.agents.keys()),
      };
    },
  });
}
