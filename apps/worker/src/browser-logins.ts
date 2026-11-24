import type { BrowserHostClient } from '@tulipfarm/browser';
import type { BrowserLogins, BrowserLoginsPrincipal } from '@tulipfarm/browser/logins';
import { errorAttributes, log } from '@tulipfarm/observability';

/**
 * At the end of a chat turn or an agent's run, saves what the session holds for each loaded login back to that login,
 * as the turn's requester or the run's owner: a refreshed sign-in replaces the saved state; a session asked to sign in
 * again marks the login as needing sign-in instead. Best effort: a failure is logged and never fails the reply or run.
 */
export async function saveBackBrowserLogins(input: {
  client: BrowserHostClient;
  logins: BrowserLogins;
  workspaceId: string;
  sessionId: string;
  actor: BrowserLoginsPrincipal;
}) {
  const { client, logins, workspaceId, actor, sessionId } = input;
  if (!logins.capabilities().enabled) return;
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

/**
 * Ends a finished run's browser: saves its logins back as the run's owner, then closes it. An unreachable host or a
 * failed close throws, so the task step retries until the session is closed; only a session the host no longer has
 * needs nothing.
 */
export async function endRunBrowser(input: {
  client: BrowserHostClient;
  logins: BrowserLogins;
  workspaceId: string;
  sessionId: string;
  owner: () => Promise<BrowserLoginsPrincipal | undefined>;
}) {
  const { client, sessionId } = input;
  if (!(await client.state(sessionId))) return;
  const actor = await input.owner();
  if (actor) await saveBackBrowserLogins({ ...input, actor });
  await client.close(sessionId);
}
