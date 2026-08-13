import { generateKeyPairSync } from "node:crypto";
import type { IntegrationHttpPort, IntegrationHttpRequest } from "@tulipfarm/integrations";
import type { SecretsService } from "@tulipfarm/secrets";
import { describe, expect, it } from "vitest";
import {
  GITHUB_INSTALLATION_SECRET_REF,
  GitHubInstallationTokenProvider,
  githubCompositeSecretProvider,
  githubInstallationSecretRef,
  isGitHubInstallationSecretRef,
  parseGitHubInstallationSecretRef,
} from "./github-credentials";
import type { GitHubInstallationDirectory, GitHubInstallationRecord } from "./github-installation";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const INSTALLATION: GitHubInstallationRecord = {
  integrationId: "integration-1",
  installationId: "install-1",
  accountLogin: "tulip",
  appExternalId: "123456",
  repositories: ["tulip/farm"],
  permissions: { issues: "write", metadata: "read" },
};

function directoryOf(records: readonly GitHubInstallationRecord[]): GitHubInstallationDirectory {
  return { list: async () => records };
}

function secretsServiceWith(values: Record<string, string>): () => Promise<SecretsService> {
  return async () =>
    ({
      get: async (key: string) => {
        const value = values[key];
        if (value === undefined) throw new Error(`no secret ${key}`);
        return value;
      },
      // biome-ignore lint/suspicious/noExplicitAny: only `get` is exercised
    }) as any;
}

function fakeHttp(handler: (request: IntegrationHttpRequest) => unknown): IntegrationHttpPort {
  return {
    async send(request) {
      return { status: 201, headers: {}, body: handler(request) };
    },
  };
}

describe("GitHubInstallationTokenProvider", () => {
  it("mints and returns an installation token", async () => {
    const now = () => new Date("2026-08-06T00:00:00.000Z");
    const http = fakeHttp((request) => {
      expect(request.path).toBe("/app/installations/install-1/access_tokens");
      return { token: "ghs_minted", expires_at: "2026-08-06T01:00:00.000Z" };
    });
    const provider = new GitHubInstallationTokenProvider({
      http,
      installations: directoryOf([INSTALLATION]),
      secrets: secretsServiceWith({ "integration.github.GITHUB_APP_PRIVATE_KEY": PRIVATE_KEY_PEM }),
      now,
    });

    const resolved = await provider.resolveCurrent(GITHUB_INSTALLATION_SECRET_REF);
    expect(resolved).toEqual({ value: "ghs_minted" });
  });

  it("caches the token until inside the refresh margin", async () => {
    let calls = 0;
    let clock = new Date("2026-08-06T00:00:00.000Z").getTime();
    const now = () => new Date(clock);
    const http = fakeHttp(() => {
      calls += 1;
      return { token: `ghs_${calls}`, expires_at: "2026-08-06T01:00:00.000Z" };
    });
    const provider = new GitHubInstallationTokenProvider({
      http,
      installations: directoryOf([INSTALLATION]),
      secrets: secretsServiceWith({ "integration.github.GITHUB_APP_PRIVATE_KEY": PRIVATE_KEY_PEM }),
      now,
    });

    const first = await provider.resolveCurrent(GITHUB_INSTALLATION_SECRET_REF);
    expect(first).toEqual({ value: "ghs_1" });

    // Still outside the 5-minute refresh margin: cache holds.
    clock += 10 * 60 * 1000;
    const second = await provider.resolveCurrent(GITHUB_INSTALLATION_SECRET_REF);
    expect(second).toEqual({ value: "ghs_1" });
    expect(calls).toBe(1);

    // Now inside the refresh margin: mints again.
    clock += 50 * 60 * 1000;
    const third = await provider.resolveCurrent(GITHUB_INSTALLATION_SECRET_REF);
    expect(third).toEqual({ value: "ghs_2" });
    expect(calls).toBe(2);
  });

  it("returns null for any other secret ref", async () => {
    const provider = new GitHubInstallationTokenProvider({
      http: fakeHttp(() => ({})),
      installations: directoryOf([INSTALLATION]),
      secrets: secretsServiceWith({}),
      now: () => new Date(),
    });
    expect(await provider.resolveCurrent("secret://something/else")).toBeNull();
  });

  it("fails closed when no installation is active", async () => {
    const provider = new GitHubInstallationTokenProvider({
      http: fakeHttp(() => ({})),
      installations: directoryOf([]),
      secrets: secretsServiceWith({ "integration.github.GITHUB_APP_PRIVATE_KEY": PRIVATE_KEY_PEM }),
      now: () => new Date(),
    });
    expect(await provider.resolveCurrent(GITHUB_INSTALLATION_SECRET_REF)).toBeNull();
  });

  it("fails closed when more than one installation is active", async () => {
    const second: GitHubInstallationRecord = {
      ...INSTALLATION,
      integrationId: "integration-2",
      installationId: "install-2",
      repositories: ["tulip/other"],
    };
    const provider = new GitHubInstallationTokenProvider({
      http: fakeHttp(() => ({})),
      installations: directoryOf([INSTALLATION, second]),
      secrets: secretsServiceWith({ "integration.github.GITHUB_APP_PRIVATE_KEY": PRIVATE_KEY_PEM }),
      now: () => new Date(),
    });
    expect(await provider.resolveCurrent(GITHUB_INSTALLATION_SECRET_REF)).toBeNull();
  });

  it("fails closed when the private key secret is unreadable", async () => {
    const provider = new GitHubInstallationTokenProvider({
      http: fakeHttp(() => ({ token: "ghs", expires_at: "2026-08-06T01:00:00.000Z" })),
      installations: directoryOf([INSTALLATION]),
      secrets: secretsServiceWith({}),
      now: () => new Date(),
    });
    expect(await provider.resolveCurrent(GITHUB_INSTALLATION_SECRET_REF)).toBeNull();
  });

  it("fails closed when the token exchange is rejected", async () => {
    const http: IntegrationHttpPort = {
      async send() {
        return { status: 404, headers: {}, body: {} };
      },
    };
    const provider = new GitHubInstallationTokenProvider({
      http,
      installations: directoryOf([INSTALLATION]),
      secrets: secretsServiceWith({ "integration.github.GITHUB_APP_PRIVATE_KEY": PRIVATE_KEY_PEM }),
      now: () => new Date(),
    });
    expect(await provider.resolveCurrent(GITHUB_INSTALLATION_SECRET_REF)).toBeNull();
  });
});

describe("githubCompositeSecretProvider", () => {
  it("routes the installation-token ref to the github provider and everything else to base", async () => {
    const base = { resolveCurrent: async (ref: string) => ({ value: `base:${ref}` }) };
    const github = { resolveCurrent: async (ref: string) => ({ value: `github:${ref}` }) };
    const composite = githubCompositeSecretProvider(base, github);

    expect(await composite.resolveCurrent(GITHUB_INSTALLATION_SECRET_REF)).toEqual({
      value: `github:${GITHUB_INSTALLATION_SECRET_REF}`,
    });
    expect(await composite.resolveCurrent("secret://llm/openai")).toEqual({
      value: "base:secret://llm/openai",
    });
  });
});

const SECOND_INSTALLATION: GitHubInstallationRecord = {
  integrationId: "integration-2",
  installationId: "install-2",
  accountLogin: "acme",
  appExternalId: "123456",
  repositories: ["acme/widgets"],
  permissions: { issues: "write", metadata: "read" },
};

describe("installation-selective credential refs", () => {
  function providerOver(records: readonly GitHubInstallationRecord[]) {
    return new GitHubInstallationTokenProvider({
      http: fakeHttp((request) => {
        const matched = /^\/app\/installations\/(.+)\/access_tokens$/.exec(request.path);
        if (matched === null) throw new Error(`unexpected request: ${request.path}`);
        return { token: `ghs_${matched[1]}`, expires_at: "2026-08-06T01:00:00.000Z" };
      }),
      installations: directoryOf(records),
      secrets: secretsServiceWith({ "integration.github.GITHUB_APP_PRIVATE_KEY": PRIVATE_KEY_PEM }),
      now: () => new Date("2026-08-06T00:00:00.000Z"),
    });
  }

  it("round-trips every selector through its ref", () => {
    expect(parseGitHubInstallationSecretRef(githubInstallationSecretRef({ kind: "any" }))).toEqual({
      kind: "any",
    });
    expect(
      parseGitHubInstallationSecretRef(
        githubInstallationSecretRef({ kind: "repository", repository: "tulip/farm" })
      )
    ).toEqual({ kind: "repository", repository: "tulip/farm" });
    expect(
      parseGitHubInstallationSecretRef(
        githubInstallationSecretRef({ kind: "account", owner: "tulip" })
      )
    ).toEqual({ kind: "account", owner: "tulip" });
  });

  it("reads a malformed scoped ref as unowned rather than widening it to the bare ref", () => {
    expect(
      parseGitHubInstallationSecretRef(`${GITHUB_INSTALLATION_SECRET_REF}/repo/no-slash`)
    ).toBeUndefined();
    expect(
      parseGitHubInstallationSecretRef(`${GITHUB_INSTALLATION_SECRET_REF}/account/`)
    ).toBeUndefined();
    expect(parseGitHubInstallationSecretRef("secret://something/else")).toBeUndefined();
    // Still owned by this provider, so it is denied here rather than falling through to `base`.
    expect(isGitHubInstallationSecretRef(`${GITHUB_INSTALLATION_SECRET_REF}/repo/no-slash`)).toBe(
      true
    );
  });

  it("mints each installation's own token from a repository-scoped ref", async () => {
    const provider = providerOver([INSTALLATION, SECOND_INSTALLATION]);
    expect(
      await provider.resolveCurrent(
        githubInstallationSecretRef({ kind: "repository", repository: "tulip/farm" })
      )
    ).toEqual({ value: "ghs_install-1" });
    expect(
      await provider.resolveCurrent(
        githubInstallationSecretRef({ kind: "repository", repository: "acme/widgets" })
      )
    ).toEqual({ value: "ghs_install-2" });
  });

  it("refuses the bare ref with several installations but honours a scoped one", async () => {
    const provider = providerOver([INSTALLATION, SECOND_INSTALLATION]);
    expect(await provider.resolveCurrent(GITHUB_INSTALLATION_SECRET_REF)).toBeNull();
    expect(
      await provider.resolveCurrent(githubInstallationSecretRef({ kind: "account", owner: "acme" }))
    ).toEqual({ value: "ghs_install-2" });
  });

  it("refuses a selector no installation matches rather than borrowing the sole one", async () => {
    const provider = providerOver([INSTALLATION]);
    expect(
      await provider.resolveCurrent(
        githubInstallationSecretRef({ kind: "repository", repository: "other/repo" })
      )
    ).toBeNull();
  });

  it("refuses when two installations list the same repository", async () => {
    const overlapping: GitHubInstallationRecord = {
      ...SECOND_INSTALLATION,
      repositories: ["tulip/farm"],
    };
    const provider = providerOver([INSTALLATION, overlapping]);
    expect(
      await provider.resolveCurrent(
        githubInstallationSecretRef({ kind: "repository", repository: "tulip/farm" })
      )
    ).toBeNull();
  });
});
