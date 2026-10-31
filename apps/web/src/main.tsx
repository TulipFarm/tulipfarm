import './features/chat/approval-mock-api';
import './features/soul-explorer/mock-api';
import './features/settings/memory-mock-api';
import './features/chat/canvas-mock-api';
import './features/chat/bud-mock-api';
import './features/workflows/workflow-mock-api';
import './features/governance/invite-members-mock-api';
import './features/navigation/sidebar-mock-api';
import './features/agents/builder-mock-api';
import './features/integrations/github-mock-api';
import './features/integrations/default-knowledge-mock-api';
import './features/integrations/slack-channel-settings-mock-api';
import './features/chat/github-investigation-mock-api';
import { createRoot } from 'react-dom/client';
import './index.css';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import { applyTheme, readTheme } from './lib/theme';
import { reportBuild } from './build-info';
import { trackAssetLoadErrors } from './lib/asset-recovery';
import { captureError, startAnalytics, trackPage } from './lib/analytics';
import { AnalyticsConsent } from './components/analytics-consent';

startAnalytics();
router.subscribe('onResolved', trackPage);
trackAssetLoadErrors();
applyTheme(readTheme());
reportBuild();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement, { onCaughtError: captureError, onUncaughtError: captureError }).render(
  <>
    <RouterProvider router={router} />
    <AnalyticsConsent />
  </>,
);
