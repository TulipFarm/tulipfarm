import {
  authFlowSatisfied,
  authSecretEnvNames,
  loadBundledIntegrations,
  nextAuthStep,
  resolveAuthSteps,
  resolveGrants,
  validateAuthSteps,
} from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import type {
  IntegrationAuthRequestDoc,
  IntegrationAuthRequestRepo,
} from "../../integrations/auth-broker";
import { buildAuthorizeUrl, renderDeep, startAuthStep } from "../../integrations/auth-broker";

/* Contract tests for shipped integration manifests, not fixtures. */

const logger = { info() {}, warn() {}, error() {}, debug() {} };

class MemoryRepo implements IntegrationAuthRequestRepo {
  requests: IntegrationAuthRequestDoc[] = [];
  async create(request: IntegrationAuthRequestDoc): Promise<void> {
    this.requests.push({ ...request });
  }
  async consume(): Promise<IntegrationAuthRequestDoc | null> {
    return null;
  }
}

const endpoints = {
  callbackUrl: "https://api.example.com/api/v1/integrations/auth/callback",
  webUrl: "https://app.example.com",
  apiUrl: "https://api.example.com",
};

describe("bundled integration auth flows", () => {
  it("every shipped manifest declares a valid flow", async () => {
    const bundled = await loadBundledIntegrations(logger);
    expect(bundled.size).toBeGreaterThan(0);
    for (const [slug, entry] of bundled) {
      expect(validateAuthSteps(entry.manifest), `${slug} auth flow`).toEqual([]);
    }
  });

  it("every credential a shipped flow writes is sealed", async () => {
    const bundled = await loadBundledIntegrations(logger);
    for (const [slug, entry] of bundled) {
      const sealed = authSecretEnvNames(entry.manifest);
      for (const step of resolveAuthSteps(entry.manifest)) {
        if (step.kind === "fields") {
          for (const field of step.fields) {
            if (field.secret) expect(sealed, `${slug}: ${field.name}`).toContain(field.name);
          }
        }
        if (step.kind === "oauth2") {
          // A token or client secret that escapes sealing is written in plaintext into the
          // connection.yaml committed to the user's soul git repo.
          expect(sealed, `${slug}: ${step.token_env}`).toContain(step.token_env);
          expect(sealed, `${slug}: ${step.client_secret_env}`).toContain(step.client_secret_env);
        }
      }
    }
  });
});

describe("slack manifest", () => {
  async function slack() {
    const bundled = await loadBundledIntegrations(logger);
    const entry = bundled.get("slack");
    if (!entry) throw new Error("slack manifest missing");
    return entry.manifest;
  }

  it("declares the three-step flow and keeps no legacy credential fields", async () => {
    const manifest = await slack();
    expect(resolveAuthSteps(manifest).map((s) => s.kind)).toEqual([
      "app_manifest",
      "fields",
      "oauth2",
    ]);
    // Both legacy blocks are gone, so there is exactly one description of how Slack connects.
    expect(manifest.required_env).toBeUndefined();
    expect(manifest.install_manifest).toBeUndefined();
  });

  it("pre-registers our callback in the app manifest it asks Slack to create", async () => {
    const manifest = await slack();
    const step = resolveAuthSteps(manifest)[0];
    if (step.kind !== "app_manifest") throw new Error("expected app_manifest");
    const rendered = renderDeep(step.manifest, { callback_url: endpoints.callbackUrl }) as {
      oauth_config: { redirect_urls: string[] };
    };
    // Without this the operator would have to paste the redirect URL into Slack by hand, and
    // getting it wrong fails the OAuth step with an opaque provider error.
    expect(rendered.oauth_config.redirect_urls).toEqual([endpoints.callbackUrl]);
  });

  it("sends the operator to Slack with the manifest prefilled", async () => {
    const manifest = await slack();
    const action = await startAuthStep({
      slug: "slack",
      manifest,
      stepIndex: 0,
      env: {},
      endpoints,
      repo: new MemoryRepo(),
    });
    if (action.action !== "redirect") throw new Error("expected redirect");
    const url = new URL(action.url);
    expect(url.searchParams.get("new_app")).toBe("1");
    const submitted = JSON.parse(url.searchParams.get("manifest_json") as string) as {
      features: { agent_view: { agent_description: string }; assistant_view?: unknown };
      settings: { socket_mode_enabled: boolean };
    };
    expect(submitted.settings.socket_mode_enabled).toBe(true);
    expect(submitted.features.agent_view.agent_description).toBe(
      "Talk to TulipFarm agents from Slack."
    );
    expect(submitted.features.assistant_view).toBeUndefined();
  });

  it("acquires the bot token and workspace id that channel routing needs", async () => {
    const manifest = await slack();
    const step = resolveAuthSteps(manifest)[2];
    if (step.kind !== "oauth2") throw new Error("expected oauth2");
    expect(step.token_env).toBe("SLACK_BOT_TOKEN");
    // slack-binding.ts resolves routing from the bot token, and the workspace id is only
    // obtainable from the OAuth response without a second API call.
    expect(step.map).toEqual({ "team.id": "SLACK_TEAM_ID" });
    // Slack rejects PKCE and documents comma-separated scopes.
    expect(step.pkce).toBe(false);
    const url = new URL(
      buildAuthorizeUrl(step, {
        clientId: "cid",
        state: "s",
        redirectUri: endpoints.callbackUrl,
      })
    );
    expect(url.searchParams.get("scope")).toContain("chat:write,app_mentions:read");
    expect(url.searchParams.has("code_challenge")).toBe(false);
  });

  it("walks the operator through the steps in order as values arrive", async () => {
    const manifest = await slack();
    // The app-manifest step writes nothing, so the flow opens on operator-typed credentials.
    expect(nextAuthStep(manifest, {})?.index).toBe(1);
    expect(
      nextAuthStep(manifest, {
        SLACK_CLIENT_ID: "c",
        SLACK_CLIENT_SECRET: "s",
        SLACK_APP_TOKEN: "xapp-1",
      })?.index
    ).toBe(2);
    expect(
      nextAuthStep(manifest, {
        SLACK_CLIENT_ID: "c",
        SLACK_CLIENT_SECRET: "s",
        SLACK_APP_TOKEN: "xapp-1",
        SLACK_BOT_TOKEN: "xoxb-1",
      })
    ).toBeNull();
  });

  it("still names every env the runtime reads", async () => {
    const manifest = await slack();
    const written = new Set(
      resolveAuthSteps(manifest).flatMap((step) => {
        if (step.kind === "fields") return step.fields.map((f) => f.name);
        if (step.kind === "oauth2") return [step.token_env, ...Object.values(step.map ?? {})];
        return [];
      })
    );
    // slack-binding.ts and the integration-worker read these three by name; dropping any of them
    // from the flow would leave Slack connected but unroutable.
    expect(written).toContain("SLACK_BOT_TOKEN");
    expect(written).toContain("SLACK_APP_TOKEN");
    expect(written).toContain("SLACK_TEAM_ID");
  });

  /* Base-install GitHub permissions are locked; catch over-grant or under-grant drift. */
  it("requests exactly the permissions the locked App decision documents", async () => {
    const bundled = await loadBundledIntegrations(logger);
    const steps = resolveAuthSteps(
      bundled.get("github")?.manifest ?? { name: "", egress: { type: "none" } }
    );
    const step = steps.find((s) => s.kind === "app_manifest");
    if (step?.kind !== "app_manifest") throw new Error("github has no app_manifest step");

    expect(step.manifest.default_permissions).toEqual({
      contents: "write",
      issues: "write",
      pull_requests: "write",
      checks: "read",
      metadata: "read",
    });
    // Requesting `administration` up front is the specific thing the decision rules out.
    expect(Object.keys(step.manifest.default_permissions as object)).not.toContain(
      "administration"
    );
  });

  /* UI `grants` must match GitHub `default_permissions`; TulipFarm does not parse the manifest. */
  it("shows the operator exactly the permissions it asks GitHub for", async () => {
    const bundled = await loadBundledIntegrations(logger);
    const manifest = bundled.get("github")?.manifest;
    if (!manifest) throw new Error("github is not bundled");
    const step = resolveAuthSteps(manifest).find((s) => s.kind === "app_manifest");
    if (step?.kind !== "app_manifest") throw new Error("github has no app_manifest step");

    const declared = Object.fromEntries(
      resolveGrants(manifest).map((grant) => [grant.label, grant.access])
    );
    expect(declared).toEqual(step.manifest.default_permissions);
  });

  it("explains every permission it asks for", async () => {
    const bundled = await loadBundledIntegrations(logger);
    const manifest = bundled.get("github")?.manifest;
    if (!manifest) throw new Error("github is not bundled");
    // `metadata: read` means nothing to anyone who has not built a GitHub App. A grant list an
    // operator cannot read is a consent screen in name only.
    for (const grant of resolveGrants(manifest)) {
      expect(grant.description, `${grant.label} has no description`).toBeTruthy();
    }
  });

  it("uses a separate OAuth App for personal GitHub credentials", async () => {
    const bundled = await loadBundledIntegrations(logger);
    const manifest = bundled.get("github")?.manifest;
    if (!manifest) throw new Error("github is not bundled");
    const steps = resolveAuthSteps(manifest);
    const personal = steps.find((step) => step.kind === "oauth2" && step.personal === true);
    if (personal?.kind !== "oauth2") throw new Error("github has no personal oauth2 step");

    expect(personal.client_id_env).toBe("GITHUB_OAUTH_CLIENT_ID");
    expect(personal.client_secret_env).toBe("GITHUB_OAUTH_CLIENT_SECRET");
    expect(personal.token_env).toBe("GITHUB_OAUTH_ACCESS_TOKEN");
    expect(personal.scopes).toEqual(["repo", "read:org"]);
    expect(authSecretEnvNames(manifest)).toContain("GITHUB_OAUTH_CLIENT_SECRET");

    const businessEnv = Object.fromEntries(
      [
        "GITHUB_APP_ID",
        "GITHUB_APP_SLUG",
        "GITHUB_APP_PRIVATE_KEY",
        "GITHUB_WEBHOOK_SECRET",
        "GITHUB_CLIENT_ID",
        "GITHUB_CLIENT_SECRET",
        "GITHUB_OAUTH_CLIENT_ID",
        "GITHUB_OAUTH_CLIENT_SECRET",
        "GITHUB_INSTALLATION_ID",
      ].map((name) => [name, "set"])
    );
    expect(authFlowSatisfied(manifest, businessEnv)).toBe(true);
  });

  it("derives Slack's grants from the scopes it actually requests, without duplicates", async () => {
    const bundled = await loadBundledIntegrations(logger);
    const manifest = bundled.get("slack")?.manifest;
    if (!manifest) throw new Error("slack is not bundled");
    const labels = resolveGrants(manifest).map((grant) => grant.label);

    expect(labels).toContain("chat:write");
    // Slack lists its bot scopes twice — in the app manifest and again on the authorize URL.
    expect(new Set(labels).size).toBe(labels.length);
  });
});
