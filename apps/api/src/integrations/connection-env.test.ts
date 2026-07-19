import type { IntegrationManifest } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import {
  type ConnectionSecretStore,
  deleteConnectionSecrets,
  integrationSecretKey,
  resolveConnectionEnv,
  resolveSecretRef,
  sealConnectionEnv,
} from "./connection-env";

class FakeSecretStore implements ConnectionSecretStore {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string> {
    const value = this.values.get(key);
    if (value === undefined) throw new Error(`secret unavailable: ${key}`);
    return value;
  }

  async set(key: string, plaintext: string): Promise<void> {
    this.values.set(key, plaintext);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list(): Promise<Array<{ key: string }>> {
    return [...this.values.keys()].map((key) => ({ key }));
  }
}

const manifest: IntegrationManifest = {
  name: "slack",
  egress: { type: "mcp", entry: { transport: "stdio", command: "npx", args: [] } },
  required_env: [
    { name: "SLACK_BOT_TOKEN", label: "Bot Token", secret: true },
    { name: "SLACK_SIGNING_SECRET", label: "Signing Secret", secret: true },
    { name: "SLACK_TEAM_ID", label: "Team ID", secret: false },
  ],
};

describe("sealConnectionEnv", () => {
  it("moves secret-flagged values to the store and replaces them with refs", async () => {
    const store = new FakeSecretStore();
    const sealed = await sealConnectionEnv(
      "slack",
      manifest,
      { SLACK_BOT_TOKEN: "xoxb-secret", SLACK_TEAM_ID: "T012AB3CD" },
      store
    );

    expect(sealed).toEqual({
      SLACK_BOT_TOKEN: "secret://integration.slack.SLACK_BOT_TOKEN",
      SLACK_TEAM_ID: "T012AB3CD",
    });
    expect(store.values.get("integration.slack.SLACK_BOT_TOKEN")).toBe("xoxb-secret");
    expect(store.values.has("integration.slack.SLACK_TEAM_ID")).toBe(false);
  });

  it("passes already-sealed refs through without re-storing", async () => {
    const store = new FakeSecretStore();
    const ref = "secret://integration.slack.SLACK_BOT_TOKEN";
    const sealed = await sealConnectionEnv("slack", manifest, { SLACK_BOT_TOKEN: ref }, store);

    expect(sealed.SLACK_BOT_TOKEN).toBe(ref);
    expect(store.values.size).toBe(0);
  });

  it("treats the OAuth token and client secret env vars as secret even when unlisted", async () => {
    const store = new FakeSecretStore();
    const oauthManifest: IntegrationManifest = {
      ...manifest,
      required_env: [],
      oauth: {
        flows: {},
        "x-tulipfarm": {
          client_id_env: "SLACK_CLIENT_ID",
          client_secret_env: "SLACK_CLIENT_SECRET",
          token_env: "SLACK_BOT_TOKEN",
        },
      },
    };
    const sealed = await sealConnectionEnv(
      "slack",
      oauthManifest,
      { SLACK_BOT_TOKEN: "xoxb-oauth", SLACK_CLIENT_SECRET: "shhh", SLACK_CLIENT_ID: "123.456" },
      store
    );

    expect(sealed.SLACK_BOT_TOKEN).toBe("secret://integration.slack.SLACK_BOT_TOKEN");
    expect(sealed.SLACK_CLIENT_SECRET).toBe("secret://integration.slack.SLACK_CLIENT_SECRET");
    expect(sealed.SLACK_CLIENT_ID).toBe("123.456");
  });

  it("leaves empty values alone so 'not provided' stays visible in the file", async () => {
    const store = new FakeSecretStore();
    const sealed = await sealConnectionEnv("slack", manifest, { SLACK_BOT_TOKEN: "" }, store);
    expect(sealed.SLACK_BOT_TOKEN).toBe("");
    expect(store.values.size).toBe(0);
  });
});

describe("resolveConnectionEnv", () => {
  it("resolves refs and passes plaintext through (legacy connection.yaml compat)", async () => {
    const store = new FakeSecretStore();
    await store.set("integration.slack.SLACK_BOT_TOKEN", "xoxb-secret");

    const resolved = await resolveConnectionEnv(
      {
        SLACK_BOT_TOKEN: "secret://integration.slack.SLACK_BOT_TOKEN",
        SLACK_TEAM_ID: "T012AB3CD",
        LEGACY_PLAINTEXT: "still-works",
      },
      store
    );

    expect(resolved).toEqual({
      SLACK_BOT_TOKEN: "xoxb-secret",
      SLACK_TEAM_ID: "T012AB3CD",
      LEGACY_PLAINTEXT: "still-works",
    });
  });

  it("throws when a referenced secret is missing", async () => {
    const store = new FakeSecretStore();
    await expect(
      resolveConnectionEnv({ SLACK_BOT_TOKEN: "secret://integration.slack.SLACK_BOT_TOKEN" }, store)
    ).rejects.toThrow(/secret unavailable/);
  });
});

describe("resolveSecretRef", () => {
  it("resolves a ref, passes plaintext through, and returns undefined when missing", async () => {
    const store = new FakeSecretStore();
    await store.set("integration.slack.SLACK_BOT_TOKEN", "xoxb-secret");

    await expect(
      resolveSecretRef("secret://integration.slack.SLACK_BOT_TOKEN", store)
    ).resolves.toBe("xoxb-secret");
    await expect(resolveSecretRef("plain-value", store)).resolves.toBe("plain-value");
    await expect(resolveSecretRef("secret://integration.slack.MISSING", store)).resolves.toBe(
      undefined
    );
  });
});

describe("deleteConnectionSecrets", () => {
  it("removes only the integration's own secrets", async () => {
    const store = new FakeSecretStore();
    await store.set(integrationSecretKey("slack", "SLACK_BOT_TOKEN"), "a");
    await store.set(integrationSecretKey("slack", "SLACK_SIGNING_SECRET"), "b");
    await store.set(integrationSecretKey("github", "GITHUB_TOKEN"), "c");
    await store.set("soul-git-credential", "d");

    await deleteConnectionSecrets("slack", store);

    expect([...store.values.keys()].sort()).toEqual([
      "integration.github.GITHUB_TOKEN",
      "soul-git-credential",
    ]);
  });
});
