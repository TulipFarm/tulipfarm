import { apiOrigin } from './auth';

const pausedKey = 'tulipfarm.devAutoSignIn';

/** Keeps this tab on the login page after a local logout, so sign-in stays testable. */
export function pauseDevAutoSignIn() {
  if (import.meta.env.DEV) sessionStorage.setItem(pausedKey, 'paused');
}

/**
 * Local `pnpm dev` only: when the API offers it (see DEV_AUTO_SIGN_IN), signs in as the mock dev user
 * through /v1/dev/session instead of showing the login page. Never resolves once it navigates away.
 */
export async function devAutoSignIn(destination: string) {
  if (!import.meta.env.DEV || sessionStorage.getItem(pausedKey)) return;
  try {
    const response = await fetch(`${apiOrigin}/v1/auth/options`, { credentials: 'omit', cache: 'no-store' });
    if (!response.ok || (await response.json())?.devAutoSignIn !== true) return;
  } catch {
    return;
  }
  const url = new URL(`${apiOrigin}/v1/dev/session`, window.location.origin);
  url.searchParams.set('redirect', destination);
  window.location.replace(url);
  await new Promise(() => {});
}
