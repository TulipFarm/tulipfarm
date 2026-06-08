// Derive the cookie `Secure` flag from the PUBLIC_URL scheme, not NODE_ENV
// (INSTALLATION INST-003c). https -> Secure; http or unset -> not Secure, so a
// fresh `http://<ip>:<port>` install can log in, and cookies auto-harden once an
// `https://` PUBLIC_URL is configured behind TLS — no code change.
export function cookieSecure(): boolean {
  const url = process.env.PUBLIC_URL;
  if (!url) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
