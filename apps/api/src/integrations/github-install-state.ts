import {
  resolveSigningKey,
  type SigningKeyStore,
  signingKeyResolver,
  signToken,
  verifyToken,
} from "../identity/signed-token";

/**
 * CSRF `state` for the GitHub App install redirect (`GET .../install/start` ->
 * github.com/apps/<slug>/installations/new?state=... -> `GET .../install/callback`). Unlike
 * `identity/channel-link.ts`'s bind flow, nothing needs to be looked up by this token — GitHub's
 * callback already carries everything the callback needs (`installation_id`, `setup_action`). Its
 * only job is proving the callback follows a redirect this deployment issued, so no database row
 * is required: a short-lived HMAC over the issue time is enough, using the same signed-token codec
 * `channel-link.ts` uses (`identity/signed-token.ts`) with a TTL check on top instead of a row.
 */

export const GITHUB_INSTALL_STATE_SIGNING_KEY = "github-install.signing-key";
export const GITHUB_INSTALL_STATE_TTL_MS = 10 * 60_000;

/** Just enough of `SecretsService` to hold one key, mirroring `ChannelBindKeyStore`. */
export type GitHubInstallStateKeyStore = SigningKeyStore;

/** Provisions the signing key on first use, same race-safe re-read as `resolveChannelBindKey`. */
export async function resolveGitHubInstallStateKey(
  secrets: GitHubInstallStateKeyStore
): Promise<Buffer> {
  return resolveSigningKey(secrets, GITHUB_INSTALL_STATE_SIGNING_KEY);
}

/** Memoizes the key for the process, same as `channelBindKeyResolver`. */
export function githubInstallStateKeyResolver(
  secrets: GitHubInstallStateKeyStore
): () => Promise<Buffer> {
  return signingKeyResolver(secrets, GITHUB_INSTALL_STATE_SIGNING_KEY);
}

interface InstallStateClaims {
  issuedAt: number;
}

export function issueInstallState(key: Buffer, now: () => Date = () => new Date()): string {
  return signToken<InstallStateClaims>(key, { issuedAt: now().getTime() });
}

/** Constant-time verify + TTL check. Any malformed input is rejected, never throws. */
export function verifyInstallState(
  key: Buffer,
  token: string,
  now: () => Date = () => new Date()
): boolean {
  const claims = verifyToken<InstallStateClaims>(key, token);
  if (claims === null || typeof claims.issuedAt !== "number") return false;
  return now().getTime() - claims.issuedAt < GITHUB_INSTALL_STATE_TTL_MS;
}
