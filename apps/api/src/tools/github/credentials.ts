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
 * GitHub credential refs are installation-selective and fail closed on ambiguity.
 * `selectGitHubInstallation` is shared with scope resolution to prevent confused deputies.
 */
export const GITHUB_INSTALLATION_SECRET_REF = "secret://integrations/github/installation-token";

/** `any` resolves only when exactly one active installation exists; it never falls back. */
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

/** Malformed scoped refs are not treated as bare refs, avoiding silent widening. */
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

/** Selector resolution refuses every ambiguous installation match. */
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

/** One minter per resolved ref prevents cached account A tokens reaching account B calls. */
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
