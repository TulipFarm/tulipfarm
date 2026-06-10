// Derive the cookie `Secure` flag from the PUBLIC_URL scheme (INSTALLATION INST-003c).
// https -> Secure; explicit http -> not Secure, so a fresh `http://<ip>:<port>` install
// can log in, and cookies auto-harden once an `https://` PUBLIC_URL is set behind TLS.
// When PUBLIC_URL is unset/malformed we fall back to NODE_ENV so a production deploy that
// forgot to set it doesn't silently ship non-Secure cookies (index.ts also warns at boot).
export function cookieSecure(): boolean {
  const url = process.env.PUBLIC_URL;
  if (!url) return process.env.NODE_ENV === "production";
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return process.env.NODE_ENV === "production";
  }
}
