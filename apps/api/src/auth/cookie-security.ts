// Single source of truth for the `Secure` cookie attribute.
//
// This was previously `NODE_ENV === "production"`, duplicated at four call sites. That is
// wrong for the shipped image: it always sets NODE_ENV=production but serves plain HTTP on
// :8080 until an operator puts TLS in front. A `Secure` cookie on an `http://` origin is
// discarded by the browser (localhost excepted), so the session cookie never came back and
// login silently failed on every LAN- or public-IP install.
//
// PUBLIC_URL is what actually describes the origin users reach, so it decides.

/** `PUBLIC_URL` decides cookie `Secure`; `NODE_ENV` remains a legacy fallback. */
export function useSecureCookies(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.startsWith("https://");
  return env.NODE_ENV === "production";
}

/** Shared options for the session cookie. */
export function sessionCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: useSecureCookies(),
    path: "/",
    maxAge,
  };
}
