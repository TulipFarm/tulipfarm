import type { ComponentType } from 'react';
import {
  createOverrideRegistry,
  defineWebExtension,
  guardBrowserAnalytics,
  noopBrowserAnalytics,
  type BrowserAnalytics,
  type WebExtension,
} from '@tulipfarm/extensions/web';
import webExtensions from 'virtual:tulipfarm-web-extensions';

/** A workspace credit balance; `null` means the deployment does not meter that value. */
export type CreditBalance = { available: number | null; granted: number | null };
export type SidebarCreditsProps = { workspaceId: string; slug: string };

export const creditsAreUnlimited = (balance: CreditBalance) => balance.available === null || balance.granted === null;

// Self-hosted workspaces are unmetered, so the default shows no balance at all.
function UnlimitedCredits(_props: SidebarCreditsProps) {
  return null;
}

/** Every web entry an extension may override, with its open-source default. */
export type WebSlots = {
  /** Browser product analytics and error reporting. */
  analytics: BrowserAnalytics;
  /** Credit balance in the workspace sidebar footer. */
  credits: ComponentType<SidebarCreditsProps>;
  /** The workspace Settings → Usage page. `null` removes the route and its navigation entries. */
  usage: ComponentType | null;
};

export const overrides = createOverrideRegistry<WebSlots>({
  analytics: noopBrowserAnalytics,
  credits: UnlimitedCredits,
  usage: null,
});
overrides.apply(webExtensions);

export const analytics = guardBrowserAnalytics(overrides.get('analytics'));

export const defineTulipfarmWebExtension = (extension: WebExtension<WebSlots>) => defineWebExtension(extension);
