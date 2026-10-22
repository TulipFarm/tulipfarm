import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SocialPlatformApps } from '@tulipfarm/extensions';
import {
  accessTierSchema,
  isAccessTierFor,
  platforms,
  type AccessTier,
  type AppSource,
  type Capability,
  type Platform,
  type PlatformAvailability,
} from './contracts.ts';

/** The actions each declared access tier is approved for (PRODUCT 2). A tier is a declaration, not a platform check. */
export const tierCapabilities = {
  linkedin: {
    share: ['publish', 'publish-public'],
    'community-management': ['publish', 'publish-public', 'analytics', 'comments'],
  },
  // Uploads from an unverified Google project are locked to private.
  youtube: {
    unverified: ['publish', 'analytics', 'comments'],
    verified: ['publish', 'publish-public', 'analytics', 'comments'],
  },
  facebook: {
    standard: ['publish', 'publish-public', 'analytics', 'comments'],
    advanced: ['publish', 'publish-public', 'analytics', 'comments', 'messages'],
  },
  instagram: {
    standard: ['publish', 'publish-public', 'analytics', 'comments'],
    advanced: ['publish', 'publish-public', 'analytics', 'comments', 'messages'],
  },
  threads: {
    standard: ['publish', 'publish-public', 'analytics', 'comments'],
    advanced: ['publish', 'publish-public', 'analytics', 'comments'],
  },
  // Trial Pins and unaudited TikTok posts are visible only to their creator.
  pinterest: { trial: ['publish'], standard: ['publish', 'publish-public', 'analytics'] },
  tiktok: { unaudited: ['publish'], audited: ['publish', 'publish-public'] },
  x: { paid: ['publish', 'publish-public', 'analytics', 'comments', 'messages'] },
  reddit: { paid: ['publish', 'publish-public', 'comments', 'messages'] },
} as const satisfies { [P in Platform]: Record<string, readonly Capability[]> };

export function capabilitiesFor(platform: Platform, tier: AccessTier): Capability[] {
  const byTier = tierCapabilities[platform] as Record<string, readonly Capability[]>;
  return isAccessTierFor(platform, tier) ? [...(byTier[tier] ?? [])] : [];
}

/** Platforms that a hosted deployment never serves through its own app (PRODUCT 4). */
export const workspaceAppOnlyWhenHosted: ReadonlySet<Platform> = new Set(['x', 'reddit']);

export const operatorPrefixes = {
  linkedin: 'SOCIAL_LINKEDIN',
  youtube: 'SOCIAL_YOUTUBE',
  facebook: 'SOCIAL_FACEBOOK',
  instagram: 'SOCIAL_INSTAGRAM',
  threads: 'SOCIAL_THREADS',
  pinterest: 'SOCIAL_PINTEREST',
  tiktok: 'SOCIAL_TIKTOK',
  x: 'SOCIAL_X',
  reddit: 'SOCIAL_REDDIT',
} as const satisfies Record<Platform, string>;

const appCredentialsSchema = z.strictObject({
  clientId: z.string().min(1).max(512),
  clientSecret: z.string().min(1).max(4096),
  accessTier: accessTierSchema,
  redirectUri: z.url().max(2048),
});
export type OperatorPlatformApp = z.infer<typeof appCredentialsSchema>;
export type OperatorPlatformApps = Partial<Record<Platform, OperatorPlatformApp>>;

/** Operator apps from `SOCIAL_<PLATFORM>_*`. A platform with an incomplete or mismatched setting has no app. */
export function operatorPlatformApps(env: NodeJS.ProcessEnv = process.env): OperatorPlatformApps {
  const apps: OperatorPlatformApps = {};
  for (const platform of platforms) {
    const prefix = operatorPrefixes[platform];
    const parsed = appCredentialsSchema.safeParse({
      clientId: env[`${prefix}_CLIENT_ID`],
      clientSecret: env[`${prefix}_CLIENT_SECRET`],
      redirectUri: env[`${prefix}_REDIRECT_URI`],
      accessTier: env[`${prefix}_ACCESS_TIER`],
    });
    if (parsed.success && isAccessTierFor(platform, parsed.data.accessTier)) apps[platform] = parsed.data;
  }
  return apps;
}

export type ResolvedPlatformApp = {
  source: AppSource;
  platformAppId: string | null;
  /** The workspace or hosted app generation; operator apps have none. */
  generation: number | null;
  clientId: string;
  clientSecret: string;
  accessTier: AccessTier;
  redirectUri: string;
  /** Identifies a hosted or operator app, so replacing it is detected (PRODUCT 6). Null for workspace apps. */
  fingerprint: string | null;
};

export type PlatformAppResolution =
  | { kind: 'app'; app: ResolvedPlatformApp }
  | { kind: 'workspace-app-required' }
  | { kind: 'unavailable' };

export type WorkspacePlatformApp = {
  id: string;
  platform: Platform;
  generation: number;
  clientId: string;
  clientSecret: string;
  accessTier: AccessTier;
};

const hostedResolutionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('app'),
    app: z.object({
      clientId: z.string().min(1).max(512),
      clientSecret: z.string().min(1).max(4096),
      accessTier: accessTierSchema,
      generation: z.number().int().positive(),
      redirectUri: z.url().max(2048).optional(),
    }),
  }),
  z.object({ kind: z.literal('workspace-app-required') }),
  z.object({ kind: z.literal('unavailable') }),
]);

/**
 * Hosted apps change by `generation`; operator apps have none, so any change to their settings counts,
 * as for Atlassian's operator configuration.
 */
export function appFingerprint(platform: Platform, app: Omit<ResolvedPlatformApp, 'fingerprint' | 'platformAppId'>) {
  const identity =
    app.source === 'operator'
      ? [app.clientId, app.clientSecret, app.redirectUri, app.accessTier]
      : [app.generation, app.clientId, app.accessTier];
  return createHash('sha256')
    .update(JSON.stringify([platform, app.source, ...identity]))
    .digest('hex');
}

export function createPlatformApps(options: {
  /** The `socialPlatformApps` extension slot; set only on hosted TulipFarm. */
  hosted: SocialPlatformApps | undefined;
  operator: OperatorPlatformApps;
  /** TulipFarm's social OAuth callback, used by workspace and hosted apps. */
  callbackUrl: string;
}) {
  const callbackUrl = z.url().parse(options.callbackUrl);
  return {
    hosted: options.hosted !== undefined,
    /** The hosted or operator app for a platform when the person chose no workspace app. */
    async resolveDefault(platform: Platform, workspaceId: string): Promise<PlatformAppResolution> {
      if (options.hosted) {
        // Resolution stops here on hosted TulipFarm: operator settings are never consulted.
        if (workspaceAppOnlyWhenHosted.has(platform)) return { kind: 'workspace-app-required' };
        let resolution;
        try {
          resolution = hostedResolutionSchema.safeParse(await options.hosted.resolve(platform, { workspaceId }));
        } catch {
          return { kind: 'unavailable' };
        }
        if (!resolution.success) return { kind: 'unavailable' };
        if (resolution.data.kind !== 'app') return { kind: resolution.data.kind };
        const hosted = resolution.data.app;
        if (!isAccessTierFor(platform, hosted.accessTier)) return { kind: 'unavailable' };
        const app = {
          source: 'hosted' as const,
          generation: hosted.generation,
          clientId: hosted.clientId,
          clientSecret: hosted.clientSecret,
          accessTier: hosted.accessTier,
          redirectUri: hosted.redirectUri ?? callbackUrl,
        };
        return { kind: 'app', app: { ...app, platformAppId: null, fingerprint: appFingerprint(platform, app) } };
      }
      const operator = options.operator[platform];
      if (!operator) return { kind: 'unavailable' };
      const app = { source: 'operator' as const, generation: null, ...operator };
      return { kind: 'app', app: { ...app, platformAppId: null, fingerprint: appFingerprint(platform, app) } };
    },
    workspace(app: WorkspacePlatformApp): ResolvedPlatformApp {
      return {
        source: 'workspace',
        platformAppId: app.id,
        generation: app.generation,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        accessTier: app.accessTier,
        redirectUri: callbackUrl,
        fingerprint: null,
      };
    },
  };
}
export type PlatformApps = ReturnType<typeof createPlatformApps>;

/**
 * What the workspace can connect for one platform. The hosted or operator app comes first; a workspace's
 * own app makes a platform available when no other app does (PRODUCT 3–5).
 */
export function platformAvailability(
  platform: Platform,
  resolution: PlatformAppResolution,
  workspaceApp: { accessTier: AccessTier } | null,
  shipped: boolean,
): PlatformAvailability {
  const offered = (appSource: AppSource, accessTier: AccessTier): PlatformAvailability => ({
    platform,
    available: true,
    reason: null,
    appSource,
    accessTier,
    capabilities: capabilitiesFor(platform, accessTier),
  });
  const missing = (reason: 'workspace-app-required' | 'not-configured'): PlatformAvailability => ({
    platform,
    available: false,
    reason,
    appSource: null,
    accessTier: null,
    capabilities: [],
  });
  if (!shipped) return missing('not-configured');
  if (resolution.kind === 'app') return offered(resolution.app.source, resolution.app.accessTier);
  if (workspaceApp) return offered('workspace', workspaceApp.accessTier);
  return missing(resolution.kind === 'workspace-app-required' ? 'workspace-app-required' : 'not-configured');
}
