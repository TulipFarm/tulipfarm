import type { BrowserAnalyticsWorkspace } from '@tulipfarm/extensions/web';
import { analytics } from '@/extensions';
import { authClient } from './auth';
import { scrubUrls, siteOrigins } from './browser-analytics';

export { analytics };
export const redactOnboardingUrls = (value: unknown, appOrigin = siteOrigins().app) =>
  scrubUrls(value, 'app', { ...siteOrigins(), app: appOrigin });

let started = false;
let userId: string | undefined;
let workspace: BrowserAnalyticsWorkspace | undefined;

const emailDomain = (email: string | null | undefined) => {
  const at = email?.lastIndexOf('@') ?? -1;
  return at > 0
    ? email!
        .slice(at + 1)
        .trim()
        .toLowerCase() || undefined
    : undefined;
};

export function startAnalytics() {
  if (started || !analytics.configured()) return;
  started = true;
  analytics.start();
  authClient.$store.atoms.session?.subscribe(({ data, isPending }) => {
    if (isPending) return;
    const nextUser = data?.user.id;
    if (userId && nextUser !== userId) {
      analytics.logout();
      workspace = undefined;
    }
    if (nextUser && nextUser !== userId) {
      const domain = emailDomain(data?.user.email);
      analytics.identify(nextUser, domain ? { emailDomain: domain } : {});
      if (workspace) analytics.workspace(workspace);
    }
    userId = nextUser;
  });
}

/** Sets the open workspace, or clears it with `undefined` when the user leaves the workspace. */
export function setAnalyticsWorkspace(next: BrowserAnalyticsWorkspace | undefined) {
  workspace = next;
  analytics.workspace(next);
}

export function trackPage() {
  analytics.pageview();
}

export function captureError(error: unknown) {
  console.error(error);
  analytics.captureException(error);
}
