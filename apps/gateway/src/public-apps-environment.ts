import type { Pool } from 'pg';
import { readCurrentAppRoute } from '@tulipfarm/apps/store';
import { appHost } from '@tulipfarm/extensions';
import { isFeatureEnabled } from '@tulipfarm/observability';
import type { PublicAppsDependencies } from './public-apps.ts';

/** Public app dependencies from the environment, or null when no apps domain is configured. */
export function publicAppsFromEnvironment(
  env: NodeJS.ProcessEnv,
  platform: Pick<Pool, 'query'>,
): PublicAppsDependencies | null {
  const domain = env.TULIPFARM_APP_SITES_DOMAIN?.toLowerCase();
  if (!domain) return null;
  return {
    domain,
    route: name => readCurrentAppRoute(platform, name),
    enabled: workspaceId => isFeatureEnabled('app-hosting', null, { id: workspaceId }),
    // The registered host is read per call so the gateway can be built before extensions finish starting.
    host: { connect: (input, signal) => appHost().connect(input, signal) },
  };
}
