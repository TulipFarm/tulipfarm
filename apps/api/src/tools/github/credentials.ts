import {
  createCachingInstallationTokenMinter,
  type IntegrationHttpPort,
} from "@tulipfarm/integrations";
import {
  integrationAppById,
  integrationAppField,
  principalSecretKey,
  type SecretProvider,
  type SecretsService,
} from "@tulipfarm/secrets";
import type { GitHubInstallationDirectory } from "./installation";

/**
 * GitHub credential refs are installation-selective and fail closed on ambiguity.
 * `selectGitHubInstallation` is shared with scope resolution to prevent confused deputies.
 */
export const GITHUB_INSTALLATION_SECRET_REF = "secret://integrations/github/installation-token";
export const GITHUB_PERSONAL_TOKEN_ENV = "GITHUB_OAUTH_ACCESS_TOKEN";
const GITHUB_PERSONAL_SECRET_REF = "secret://integrations/github/personal";

export type GitHubCredentialPrincipal = { readonly kind: string; readonly id: string };

/** The principal-scoped ref recorded in a human-triggered GitHub effect. */
export function githubPersonalSecretRef(principal: GitHubCredentialPrincipal): string {
  return `${GITHUB_PERSONAL_SECRET_REF}/${encodeURIComponent(principal.kind)}/${encodeURIComponent(principal.id)}`;
}

function parseGitHubPersonalSecretRef(secretRef: string): GitHubCredentialPrincipal | undefined {
  const prefix = `${GITHUB_PERSONAL_SECRET_REF}/`;
  if (!secretRef.startsWith(prefix)) return undefined;
  const parts = secretRef.slice(prefix.length).split("/");
  if (parts.length !== 2) return undefined;
  try {
    const kind = decodeURIComponent(parts[0] ?? "");
    const id = decodeURIComponent(parts[1] ?? "");
    return kind === "" || id === "" ? undefined : { kind, id };
  } catch {
    return undefined;
  }
}

export function isGitHubPersonalSecretRef(secretRef: string): boolean {
  return parseGitHubPersonalSecretRef(secretRef) !== undefined;
}

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
      // A missing private key resolves to "no credential"; the caller handles undefined.
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

/** Resolves only the principal named by the ref; there is no installation-token fallback. */
export class GitHubPersonalTokenProvider implements SecretProvider {
  constructor(private readonly secrets: () => Promise<SecretsService>) {}

  async resolveCurrent(secretRef: string) {
    const principal = parseGitHubPersonalSecretRef(secretRef);
    if (principal === undefined) return null;
    try {
      return {
        value: await (await this.secrets()).get(
          principalSecretKey(principal, "github", GITHUB_PERSONAL_TOKEN_ENV)
        ),
      };
    } catch {
      return null;
    }
  }
}

/** Routes GitHub refs to their narrow provider; unrelated refs fall through to `base`. */
export function githubCompositeSecretProvider(
  base: SecretProvider,
  installation: SecretProvider,
  personal: SecretProvider
): SecretProvider {
  return {
    async resolveCurrent(secretRef) {
      if (isGitHubInstallationSecretRef(secretRef)) return installation.resolveCurrent(secretRef);
      if (isGitHubPersonalSecretRef(secretRef)) return personal.resolveCurrent(secretRef);
      return base.resolveCurrent(secretRef);
    },
  };
}
