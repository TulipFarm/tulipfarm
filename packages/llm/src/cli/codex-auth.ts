import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Codex reads `$CODEX_HOME/auth.json`; API-key mode is refused to avoid API billing. */

/** Where the blob lives inside the jail. `codex` reads `$CODEX_HOME/auth.json`. */
export const CODEX_HOME_DIR = "codex-home";

/** Registry key for the stored Codex auth.json blob; shared with the write validator. */
export const CODEX_AUTH_SECRET_KEY = "codex-auth-json";
const AUTH_FILE = "auth.json";
/** Owner-only. The jail is already private, but the credential should not widen if that changes. */
const AUTH_FILE_MODE = 0o600;

export class CodexAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAuthError";
  }
}

interface CodexAuthBlob {
  readonly tokens?: {
    readonly refresh_token?: unknown;
    readonly access_token?: unknown;
    readonly account_id?: unknown;
  };
  readonly last_refresh?: unknown;
  readonly OPENAI_API_KEY?: unknown;
  readonly auth_mode?: unknown;
}

const SIGNUP_HINT =
  "Sign in with `codex login` (requires a ChatGPT Plus/Pro/Business plan), then paste the contents of ~/.codex/auth.json here.";

/** Validates pasted `auth.json` at save time and returns the parsed blob. */
export function parseCodexAuth(raw: string): CodexAuthBlob {
  let blob: unknown;
  try {
    blob = JSON.parse(raw);
  } catch {
    throw new CodexAuthError(`Codex credential is not valid JSON. ${SIGNUP_HINT}`);
  }
  if (!blob || typeof blob !== "object" || Array.isArray(blob)) {
    throw new CodexAuthError(`Codex credential must be a JSON object. ${SIGNUP_HINT}`);
  }
  const parsed = blob as CodexAuthBlob;
  if (typeof parsed.tokens?.refresh_token !== "string" || !parsed.tokens.refresh_token) {
    // An `{auth_mode: "apikey", OPENAI_API_KEY}` blob lands here. Name that case explicitly:
    // "missing refresh_token" would read as a corrupt file rather than the wrong sign-in mode.
    const looksLikeApiKey =
      typeof parsed.OPENAI_API_KEY === "string" || parsed.auth_mode === "apikey";
    throw new CodexAuthError(
      looksLikeApiKey
        ? `This is an API-key credential. The Codex provider is subscription-only — configure the OpenAI provider instead if you want to use an API key. ${SIGNUP_HINT}`
        : `Codex credential has no ChatGPT sign-in token (tokens.refresh_token). ${SIGNUP_HINT}`
    );
  }
  return parsed;
}

/** Materialise the stored blob into the jail, returning the `CODEX_HOME` the child will read. */
export function writeCodexHome(jailHome: string, raw: string): string {
  const home = join(jailHome, CODEX_HOME_DIR);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, AUTH_FILE), raw, { mode: AUTH_FILE_MODE });
  return home;
}

/** Reads rotated auth.json from the jail; `undefined` means no secret rewrite. */
export function readRotatedCodexAuth(codexHome: string, original: string): string | undefined {
  let current: string;
  try {
    current = readFileSync(join(codexHome, AUTH_FILE), "utf8");
  } catch {
    // The CLI deleted or never wrote it. Keep what we have rather than clearing a working
    // credential on the strength of a missing file.
    return undefined;
  }
  if (current === original) return undefined;
  try {
    // Only persist something that still parses as a usable subscription credential. A truncated
    // write (the child was SIGKILLed mid-flush) must not overwrite a good stored secret.
    parseCodexAuth(current);
  } catch {
    // A truncated or unparseable credential must not overwrite the stored one.
    return undefined;
  }
  return current;
}
