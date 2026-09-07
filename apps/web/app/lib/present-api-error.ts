import { ApiError } from "./api";

/**
 * The wire codes a route gate can send (`route-gate.ts`'s `{ error: "forbidden" }` and siblings).
 * Anything else on `ApiError.code` — including a genuinely descriptive service message, a thrown
 * error's own `.message` mirrored there by `readError` — is not a code this helper recognizes, so
 * it falls through to the generic copy below rather than risk surfacing wire detail nobody chose
 * as user-facing text.
 */
const KNOWN_WIRE_CODES: Record<string, string> = {
  forbidden: "isn't available to your account",
  denied: "isn't available to your account",
  unauthorized: "isn't available — sign in again to continue",
};

/**
 * Turns an API error into copy a person can read, for surfaces that would otherwise render a raw
 * wire code (`forbidden`) straight from the response body. `context` names the surface that failed
 * ("The Team directory"), so the result reads as a sentence naming what's unavailable and why.
 */
export function presentApiError(error: unknown, context: string): string {
  const code = error instanceof ApiError ? error.code : undefined;
  const known = code ? KNOWN_WIRE_CODES[code] : undefined;
  if (known) return `${context} ${known}. Ask an administrator if you need access.`;
  return `${context} could not be loaded. Ask an administrator if this continues.`;
}
