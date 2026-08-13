import {
  createCachingInstallationTokenMinter,
  type IntegrationHttpPort,
} from "@tulipfarm/integrations";
import {
  integrationAppById,
  integrationAppField,
  type SecretProvider,
  type SecretsService,
} from "@tulipfarm/secrets";
import type { GitHubInstallationDirectory } from "./installation";

/**
 * The `SecretProvider` a GitHub chat Tool's `credentialRef` resolves to. Mirrors
 * `apps/worker/src/routine/github-credentials.ts` (a deliberate local copy — an application may
 * not import another application).
 *
 * The ref is **installation-selective**, not installation-blind. A business may install the App on
 * more than one account, and the bare ref names no installation, so the only honest answer it can
 * give with several to choose from is `null`. A Tool call, however, always names something — the
 * repository it writes to, or the account it creates a repository under — and that selector picks
 * exactly one installation or none. Carrying that selector *in the ref* is what lets the credential
 * be resolved per call without the resolver holding any mutable "current installation" state, which
 * would be a race between an unattended Routine and a human turn in the same process.
 *
 * `selectGitHubInstallation` is the single matcher both this provider and
 * `InstallationScopeGitHubContextResolver` use. Two copies of the choice would eventually disagree,
 * and a call whose credential came from one installation while its scope check came from another is
 * exactly the confused-deputy this layer exists to prevent.
 */
export const GITHUB_INSTALLATION_SECRET_REF = "secret://integrations/github/installation-token";

/**
 * Which installation a call needs the credential of.
 *
 * `any` is the bare ref: it resolves only when the business has exactly one active installation,
 * and fails closed otherwise. It is not a fallback for a failed selection — a call that named a
 * repository no installation covers must not then borrow the sole installation's token.
 */
export type GitHubInstallationSelector =
  | { readonly kind: "any" }
  | { readonly kind: "repository"; readonly repository: string }
  | { readonly kind: "account"; readonly owner: string };

const REPOSITORY_SEGMENT = "/repo/";
const ACCOUNT_SEGMENT = "/account/";

/** The `credentialRef` a call with this selector must carry. */
export function githubInstallationSecretRef(selector: GitHubInstallationSelector): string {
  if (selector.kind === "repository") {
    return `${GITHUB_INSTALLATION_SECRET_REF}${REPOSITORY_SEGMENT}${selector.repository}`;
  }
  if (selector.kind === "account") {
    return `${GITHUB_INSTALLATION_SECRET_REF}${ACCOUNT_SEGMENT}${selector.owner}`;
  }
  return GITHUB_INSTALLATION_SECRET_REF;
}

/**
 * `undefined` for any ref this provider does not own, so the composite router and the default-deny
 * authorizer can both ask one question. A scoped ref with a malformed selector body is *not* read
 * as the bare ref — it must not silently widen to "the sole installation".
 */
export function parseGitHubInstallationSecretRef(
  secretRef: string
): GitHubInstallationSelector | undefined {
  if (secretRef === GITHUB_INSTALLATION_SECRET_REF) return { kind: "any" };
  const repositoryPrefix = `${GITHUB_INSTALLATION_SECRET_REF}${REPOSITORY_SEGMENT}`;
  if (secretRef.startsWith(repositoryPrefix)) {
    const repository = secretRef.slice(repositoryPrefix.length);
    return /^[^/]+\/[^/]+$/.test(repository) ? { kind: "repository", repository } : undefined;
  }
  const accountPrefix = `${GITHUB_INSTALLATION_SECRET_REF}${ACCOUNT_SEGMENT}`;
  if (secretRef.startsWith(accountPrefix)) {
    const owner = secretRef.slice(accountPrefix.length);
    return owner.length > 0 && !owner.includes("/") ? { kind: "account", owner } : undefined;
  }
  return undefined;
}

/** True when this provider owns the ref at all — the authorizer's and router's one question. */
export function isGitHubInstallationSecretRef(secretRef: string): boolean {
  return (
    secretRef === GITHUB_INSTALLATION_SECRET_REF ||
    secretRef.startsWith(`${GITHUB_INSTALLATION_SECRET_REF}/`)
  );
}

/**
 * The one active installation this selector names, or `undefined`.
 *
 * Refuses on ambiguity in every branch: two installations listing the same repository, or two
 * covering the same account, is a state we cannot resolve without guessing whose credential the
 * effect should be attributed to. The bare `any` selector refuses whenever there is more than one
 * installation at all, because it names nothing to disambiguate by.
 */
export function selectGitHubInstallation<
  T extends { readonly accountLogin: string; readonly repositories: readonly string[] },
>(
  installations: readonly T[],
  selector: GitHubInstallationSelector,
  log?: { warn: (obj: unknown, message?: string) => void }
): T | undefined {
  const matches =
    selector.kind === "repository"
      ? installations.filter((entry) => entry.repositories.includes(selector.repository))
      : selector.kind === "account"
        ? installations.filter((entry) => entry.accountLogin === selector.owner)
        : [...installations];

  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    log?.warn(
      { event: "github.installation.ambiguous", selector: selector.kind, count: matches.length },
      "more than one active GitHub installation matches this call; refusing to guess"
    );
    return undefined;
  }
  return matches[0];
}

const GITHUB_APP = integrationAppById("github");

export interface GitHubInstallationTokenProviderDeps {
  readonly http: IntegrationHttpPort;
  readonly installations: GitHubInstallationDirectory;
  readonly secrets: () => Promise<SecretsService>;
  readonly now?: () => Date;
  /** Warned once per resolution when more than one active installation makes the ref ambiguous. */
  readonly log?: { warn: (obj: unknown, message?: string) => void };
}

/**
 * Mints and caches a GitHub App installation access token via the shared caching sequence in
 * `@tulipfarm/integrations` (`createCachingInstallationTokenMinter`). Fails closed: any minting
 * failure — unconfigured App, unreadable private key, no matching installation, an ambiguous
 * selector, a non-2xx from GitHub — returns `null` rather than a stale or guessed token.
 *
 * One minter is kept per resolved ref rather than one per provider, because each installation has
 * its own token with its own expiry. A single shared cache would hand a call against account A the
 * token minted for account B, which the scope check would then have to catch after the credential
 * was already leased.
 */
export class GitHubInstallationTokenProvider implements SecretProvider {
  private readonly minters = new Map<string, () => Promise<string | undefined>>();

  constructor(private readonly deps: GitHubInstallationTokenProviderDeps) {}

  private minterFor(selector: GitHubInstallationSelector): () => Promise<string | undefined> {
    const key = githubInstallationSecretRef(selector);
    const existing = this.minters.get(key);
    if (existing !== undefined) return existing;
    const minter = createCachingInstallationTokenMinter({
      http: this.deps.http,
      ...(this.deps.now === undefined ? {} : { now: this.deps.now }),
      resolveContext: () => this.resolveContext(selector),
    });
    this.minters.set(key, minter);
    return minter;
  }

  private async resolveContext(selector: GitHubInstallationSelector) {
    if (GITHUB_APP === undefined) return undefined;
    const privateKeyField = integrationAppField(GITHUB_APP, "private_key");
    if (privateKeyField === undefined) return undefined;

    const installations = await this.deps.installations.list();
    const installation = selectGitHubInstallation(installations, selector, this.deps.log);
    if (installation === undefined) return undefined;

    let privateKeyPem: string;
    try {
      const secrets = await this.deps.secrets();
      privateKeyPem = await secrets.get(privateKeyField.key);
    } catch {
      return undefined;
    }

    return {
      appExternalId: installation.appExternalId,
      installationId: installation.installationId,
      privateKeyPem,
    };
  }

  async resolveCurrent(secretRef: string) {
    const selector = parseGitHubInstallationSecretRef(secretRef);
    if (selector === undefined) return null;
    const token = await this.minterFor(selector)();
    return token === undefined ? null : { value: token };
  }
}

/** Routes every GitHub installation-token ref to `github`; other refs fall through to `base`. */
export function githubCompositeSecretProvider(
  base: SecretProvider,
  github: SecretProvider
): SecretProvider {
  return {
    async resolveCurrent(secretRef) {
      if (isGitHubInstallationSecretRef(secretRef)) return github.resolveCurrent(secretRef);
      return base.resolveCurrent(secretRef);
    },
  };
}
