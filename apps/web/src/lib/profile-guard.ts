import { redirect } from '@tanstack/react-router';
import { loadSession, safeAuthRedirect } from './auth';
import { forgetSession, rememberSession } from './last-workspace';
import { loadSessionLayer } from './session-layer';

/** The current session. When there is one, the signed-in layer is loaded before the page renders. */
export async function loadSignedInSession() {
  const session = await loadSession();
  if (session) await loadSessionLayer();
  return session;
}

/** A signed-in session with a complete profile, or a redirect to sign in or finish the profile. */
export async function requireProfile(destination: string) {
  const session = await loadSignedInSession();
  if (!session) {
    void forgetSession();
    const error = new URL(destination, 'http://localhost').searchParams.get('error');
    throw redirect({
      to: '/login',
      search: { redirect: safeAuthRedirect(destination), ...(error !== null && { error }) },
      replace: true,
    });
  }
  rememberSession({ userId: session.user.id, sessionId: session.session.id });
  if (!session.user.name.trim())
    throw redirect({ to: '/complete-profile', search: { redirect: safeAuthRedirect(destination) }, replace: true });
  return session;
}
