import type { HumanActor } from '@tulipfarm/access';
import { browserSessionId, type BrowserHostClient } from '@tulipfarm/browser';
import type { BrowserLogins } from '@tulipfarm/browser/logins';
import { errorAttributes, log } from '@tulipfarm/observability';

/**
 * At the end of a chat turn, saves what the chat's browser holds for each loaded login back to that login, as the
 * turn's requester: a refreshed sign-in replaces the saved state; a session asked to sign in again marks the login as
 * needing sign-in instead. Best effort: a failure is logged and never fails the reply.
 */
export async function saveBackBrowserLogins(input: {
  client: BrowserHostClient;
  logins: BrowserLogins;
  workspaceId: string;
  conversationId: string;
  actor: HumanActor;
}) {
  const { client, logins, workspaceId, actor } = input;
  if (!logins.capabilities().enabled) return;
  const sessionId = browserSessionId(workspaceId, { conversationId: input.conversationId });
  try {
    const state = await client.state(sessionId);
    for (const login of state?.logins ?? []) {
      try {
        const saved = login.signedOut
          ? await logins.saveBack(workspaceId, actor, { id: login.id, signedOut: true })
          : await logins.saveBack(workspaceId, actor, {
              id: login.id,
              signedOut: false,
              state: await client.siteState(sessionId, login.site),
            });
        if (saved === 'skipped')
          log('info', 'activity', 'call_completed', { operation: 'browser.login-save-back', outcome: 'skipped' });
      } catch (error) {
        log('warn', 'activity', 'call_failed', { operation: 'browser.login-save-back', ...errorAttributes(error) });
      }
    }
  } catch (error) {
    log('warn', 'activity', 'call_failed', { operation: 'browser.login-save-back', ...errorAttributes(error) });
  }
}
