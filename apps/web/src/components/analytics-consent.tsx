import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { analytics } from '@/lib/analytics';
import { preferencesEvent, privacySignal, readConsent, siteOrigins } from '@/lib/browser-analytics';
import { Button } from '@tulipfarm/sprout/button';
import { useViewportInset } from '@/lib/viewport-inset';

const insetProperty = '--consent-inset';

export function AnalyticsConsent() {
  const [visible, setVisible] = useState(() => analytics.configured() && readConsent() === null);
  const [blocked, setBlocked] = useState(privacySignal);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const open = () => {
      setBlocked(privacySignal());
      setVisible(true);
    };
    window.addEventListener(preferencesEvent, open);
    return () => window.removeEventListener(preferencesEvent, open);
  }, []);
  const shown = analytics.configured() && visible;
  useViewportInset(panel, insetProperty, { enabled: shown });
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!shown) return;
    root.dataset.analyticsConsent = 'open';
    return () => {
      delete root.dataset.analyticsConsent;
    };
  }, [shown]);
  if (!shown) return null;
  const choose = (accepted: boolean) => {
    analytics.choose(accepted);
    setVisible(false);
  };
  const website = siteOrigins().marketing;
  return (
    <aside
      ref={panel}
      aria-label="Optional analytics"
      className="analytics-consent fixed inset-x-0 bottom-0 z-50 border-t border-border bg-card text-sm text-foreground"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
        <p className="leading-relaxed sm:flex-1">
          {blocked
            ? 'Your browser requests no tracking. Optional analytics stay off.'
            : 'Allow usage analytics, masked session replay and error reports across TulipFarm? If you sign in, visits link to your account. Private inputs and workspace content are hidden. Essential feature checks still use account and workspace details when you sign in.'}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {!blocked && (
            <Button variant="outline" onClick={() => choose(true)}>
              Allow analytics
            </Button>
          )}
          <Button variant="outline" onClick={() => choose(false)}>
            {blocked ? 'Close' : 'Reject analytics'}
          </Button>
          {website && (
            <a href={`${website}/privacy/`} className="text-primary-text underline underline-offset-4">
              Privacy
            </a>
          )}
        </div>
      </div>
    </aside>
  );
}
