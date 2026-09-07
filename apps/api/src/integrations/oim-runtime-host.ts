import {
  assertOimHookExecutionGrant,
  type DrainDeps,
  type IntegrationEvent,
  issueOimHookExecutionGrant,
  type OimReleasePackage,
} from "@tulipfarm/integrations";
import type { HookExecutor } from "@tulipfarm/sandbox";
import { type OimHook, type OimPackageContent, oimPackageDigest } from "@tulipfarm/schema";
import type { SoulIntegration } from "@tulipfarm/soul";
import { executeVerifiedOimHook } from "./oim-hooks";
import type { OimReleaseTrustHost } from "./oim-release-compose";

interface OimRuntimeHostDeps {
  readonly businessId: string;
  readonly integrations: () => Iterable<SoulIntegration>;
  readonly releaseTrust: Pick<
    OimReleaseTrustHost,
    "authorizeInstalledRuntime" | "authorizeInstalledToolCompilation"
  >;
  readonly hookExecutor?: Pick<HookExecutor, "runPureHook">;
}

type EventIdentity = Pick<
  IntegrationEvent,
  "businessId" | "integrationId" | "integrationMajorVersion"
>;

function packageFor(integration: SoulIntegration): OimReleasePackage {
  if (integration.oimManifest === undefined) {
    throw new Error(`OIM manifest is missing for ${integration.slug}`);
  }
  return {
    manifest: integration.oimManifest,
    files: new Map<string, OimPackageContent>(Object.entries(integration.oimPackageFiles ?? {})),
  };
}

export function createOimRuntimeHost(deps: OimRuntimeHostDeps) {
  function integrationFor(identity: EventIdentity): SoulIntegration {
    if (identity.businessId !== deps.businessId) {
      throw new Error("OIM event business does not match this deployment");
    }
    const matches = [...deps.integrations()].filter((integration) => {
      const manifest = integration.oimManifest;
      return (
        manifest?.metadata.id === identity.integrationId &&
        Number(manifest.metadata.version.split(".", 1)[0]) === identity.integrationMajorVersion
      );
    });
    const integration = matches[0];
    if (matches.length !== 1 || integration === undefined) {
      throw new Error("OIM event requires exactly one installed matching major version");
    }
    return integration;
  }

  async function authorizeIntegration(integration: SoulIntegration): Promise<void> {
    await deps.releaseTrust.authorizeInstalledRuntime({
      businessId: deps.businessId,
      package: packageFor(integration),
    });
  }

  async function run(
    integration: SoulIntegration,
    hook: OimHook,
    value: unknown
  ): Promise<unknown> {
    if (deps.hookExecutor === undefined) throw new Error("HOOKS_DISABLED");
    return executeVerifiedOimHook(
      {
        releaseTrust: {
          authorizeToolCompilation: ({ package: exactPackage }) =>
            deps.releaseTrust.authorizeInstalledToolCompilation({
              businessId: deps.businessId,
              package: exactPackage,
            }),
        },
        issueHookExecutionGrant: issueOimHookExecutionGrant,
        assertHookExecutionGrant: assertOimHookExecutionGrant,
        executor: deps.hookExecutor,
      },
      {
        package: packageFor(integration),
        hook,
        value,
      }
    );
  }

  const hookRunnerFor: NonNullable<DrainDeps["hookRunnerFor"]> = async (input) => {
    const integration = integrationFor(input);
    const exactPackage = packageFor(integration);
    if (oimPackageDigest(input.manifest) !== oimPackageDigest(exactPackage.manifest)) {
      throw new Error("OIM manifest changed before Hook setup");
    }
    await authorizeIntegration(integration);
    if ((exactPackage.manifest.hooks?.length ?? 0) === 0) return undefined;
    return { run: (hook, value) => run(integration, hook, value) };
  };

  async function authorizeEvent(identity: EventIdentity): Promise<void> {
    await authorizeIntegration(integrationFor(identity));
  }

  return { authorizeIntegration, authorizeEvent, hookRunnerFor, run };
}
