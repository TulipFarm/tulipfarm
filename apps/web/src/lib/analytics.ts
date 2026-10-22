import { analytics } from '@/extensions';
import { authClient } from './auth';
import { scrubUrls, siteOrigins } from './browser-analytics';

export { analytics };
export const redactOnboardingUrls = (value: unknown, appOrigin = siteOrigins().app) =>
  scrubUrls(value, 'app', { ...siteOrigins(), app: appOrigin });

let started = false;
let userId: string | undefined;
let workspaceId: string | undefined;

export function startAnalytics() {
  if (started || !analytics.configured()) return;
  started = true;
  analytics.start();
  authClient.$store.atoms.session?.subscribe(({ data, isPending }) => {
    if (isPending) return;
    const nextUser = data?.user.id;
    if (userId && nextUser !== userId) {
      analytics.logout();
      workspaceId = undefined;
    }
    if (nextUser && nextUser !== userId) {
      analytics.identify(nextUser);
      if (workspaceId) analytics.workspace(workspaceId);
    }
    userId = nextUser;
  });
}

export function setAnalyticsWorkspace(next: { id: string; name: string }) {
  workspaceId = next.id;
  analytics.workspace(next.id);
}

export function trackPage() {
  analytics.pageview();
}

export function captureError(error: unknown) {
  console.error(error);
  analytics.captureException(error);
}
