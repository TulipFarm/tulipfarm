import { describe, expect, it } from "vitest";
import {
  authEnvNames,
  authFlowSatisfied,
  authSecretEnvNames,
  authStepProducesEnv,
  authStepSatisfied,
  nextAuthStep,
  resolveAuthSteps,
  validateAuthSteps,
  validateIngressContextEnv,
} from "./integration-auth";
import type { AuthStep, IntegrationManifest } from "./types";

function manifest(overrides: Partial<IntegrationManifest> = {}): IntegrationManifest {
  return { name: "acme", egress: { type: "none" }, ...overrides };
}

describe("resolveAuthSteps", () => {
  it("returns the declared step list verbatim", () => {
    const auth: AuthStep[] = [{ kind: "fields", fields: [{ name: "API_KEY", label: "API key" }] }];
    expect(resolveAuthSteps(manifest({ auth }))).toEqual(auth);
  });

  it("returns an empty flow when the manifest declares no credentials", () => {
    expect(resolveAuthSteps(manifest())).toEqual([]);
  });

  it("derives a fields step from legacy required_env", () => {
    const steps = resolveAuthSteps(
      manifest({
        required_env: [
          { name: "SLACK_BOT_TOKEN", label: "Bot Token", secret: true },
          { name: "SLACK_TEAM_ID", label: "Team ID", secret: false },
        ],
      })
    );
    expect(steps).toEqual([
      {
        kind: "fields",
        fields: [
          { name: "SLACK_BOT_TOKEN", label: "Bot Token", secret: true },
          { name: "SLACK_TEAM_ID", label: "Team ID", secret: false },
        ],
      },
    ]);
  });

  it("derives an authorization_code oauth2 step from the legacy oauth block", () => {
    const steps = resolveAuthSteps(
      manifest({
        oauth: {
          flows: {
            authorizationCode: {
              authorizationUrl: "https://acme.test/authorize",
              tokenUrl: "https://acme.test/token",
              scopes: { read: "Read", write: "Write" },
            },
          },
          "x-tulipfarm": {
            client_id_env: "ACME_CLIENT_ID",
            client_secret_env: "ACME_CLIENT_SECRET",
            token_env: "ACME_TOKEN",
          },
        },
      })
    );
    expect(steps).toEqual([
      {
        kind: "oauth2",
        grant: "authorization_code",
        authorization_url: "https://acme.test/authorize",
        token_url: "https://acme.test/token",
        scopes: ["read", "write"],
        client_id_env: "ACME_CLIENT_ID",
        client_secret_env: "ACME_CLIENT_SECRET",
        token_env: "ACME_TOKEN",
        token_response_path: undefined,
      },
    ]);
  });

  it("marks the derived step client_credentials when only that flow is declared", () => {
    const steps = resolveAuthSteps(
      manifest({
        oauth: {
          flows: {
            clientCredentials: {
              authorizationUrl: "",
              tokenUrl: "https://acme.test/token",
              scopes: {},
            },
          },
          "x-tulipfarm": {
            client_id_env: "ACME_CLIENT_ID",
            client_secret_env: "ACME_CLIENT_SECRET",
            token_env: "ACME_TOKEN",
          },
        },
      })
    );
    expect(steps[0]).toMatchObject({ kind: "oauth2", grant: "client_credentials" });
  });

  it("orders legacy fields before the legacy oauth step", () => {
    const steps = resolveAuthSteps(
      manifest({
        required_env: [{ name: "ACME_CLIENT_ID", label: "Client ID" }],
        oauth: {
          flows: {
            authorizationCode: {
              authorizationUrl: "https://acme.test/authorize",
              tokenUrl: "https://acme.test/token",
              scopes: {},
            },
          },
          "x-tulipfarm": {
            client_id_env: "ACME_CLIENT_ID",
            client_secret_env: "ACME_CLIENT_SECRET",
            token_env: "ACME_TOKEN",
          },
        },
      })
    );
    expect(steps.map((step) => step.kind)).toEqual(["fields", "oauth2"]);
  });

  it("ignores the legacy fields once auth is declared", () => {
    const auth: AuthStep[] = [{ kind: "fields", fields: [{ name: "NEW", label: "New" }] }];
    const steps = resolveAuthSteps(
      manifest({ auth, required_env: [{ name: "OLD", label: "Old" }] })
    );
    expect(steps).toEqual(auth);
  });

  it("does not invent an app_manifest step from a legacy install_manifest", () => {
    // The legacy field carries the app definition but not the URL to submit it to.
    const steps = resolveAuthSteps(manifest({ install_manifest: { display_name: "TulipFarm" } }));
    expect(steps).toEqual([]);
  });
});

describe("authSecretEnvNames", () => {
  it("collects secret-flagged fields only", () => {
    const names = authSecretEnvNames(
      manifest({
        auth: [
          {
            kind: "fields",
            fields: [
              { name: "TOKEN", label: "Token", secret: true },
              { name: "TEAM_ID", label: "Team", secret: false },
              { name: "REGION", label: "Region" },
            ],
          },
        ],
      })
    );
    expect([...names]).toEqual(["TOKEN"]);
  });

  it("treats oauth2 tokens and the client secret as secret without declaration", () => {
    const names = authSecretEnvNames(
      manifest({
        auth: [
          { kind: "fields", fields: [{ name: "CID", label: "Client ID" }] },
          {
            kind: "oauth2",
            authorization_url: "https://acme.test/authorize",
            token_url: "https://acme.test/token",
            client_id_env: "CID",
            client_secret_env: "CSECRET",
            token_env: "TOKEN",
            refresh_token_env: "REFRESH",
            expires_at_env: "EXPIRES_AT",
          },
        ],
      })
    );
    expect([...names].sort()).toEqual(["CSECRET", "REFRESH", "TOKEN"]);
    // The expiry timestamp is not a credential, so it stays readable in connection.yaml.
    expect(names.has("EXPIRES_AT")).toBe(false);
    expect(names.has("CID")).toBe(false);
  });

  it("seals only the exchange values declared as secret", () => {
    const names = authSecretEnvNames(
      manifest({
        auth: [
          {
            kind: "app_manifest",
            create_url: "https://github.com/settings/apps/new",
            delivery: "form_post",
            manifest_param: "manifest",
            manifest: {},
            exchange: {
              url: "https://api.github.com/app-manifests/{code}/conversions",
              map: { id: "GITHUB_APP_ID", pem: "GITHUB_APP_PRIVATE_KEY" },
              secret_envs: ["GITHUB_APP_PRIVATE_KEY"],
            },
          },
        ],
      })
    );
    expect([...names]).toEqual(["GITHUB_APP_PRIVATE_KEY"]);
  });

  it("matches the legacy behaviour for a manifest using required_env and oauth", () => {
    const names = authSecretEnvNames(
      manifest({
        required_env: [
          { name: "SLACK_BOT_TOKEN", label: "Bot", secret: true },
          { name: "SLACK_TEAM_ID", label: "Team", secret: false },
        ],
        oauth: {
          flows: {
            authorizationCode: {
              authorizationUrl: "https://slack.test/authorize",
              tokenUrl: "https://slack.test/token",
              scopes: {},
            },
          },
          "x-tulipfarm": {
            client_id_env: "SLACK_CLIENT_ID",
            client_secret_env: "SLACK_CLIENT_SECRET",
            token_env: "SLACK_OAUTH_TOKEN",
          },
        },
      })
    );
    // The derived refresh env is sealed even though the manifest never names it: the broker writes
    // it whenever the provider rotates one, and an unsealed name is a plaintext credential in the
    // connection.yaml committed to the user's soul repo.
    expect([...names].sort()).toEqual([
      "SLACK_BOT_TOKEN",
      "SLACK_CLIENT_SECRET",
      "SLACK_OAUTH_TOKEN",
      "SLACK_OAUTH_TOKEN_REFRESH_TOKEN",
    ]);
  });

  it("still seals legacy oauth credentials when the block declares no usable flow", () => {
    // Degenerate but real: `flows: {}` resolves to no oauth2 step, yet x-tulipfarm names live
    // credentials. Failing open here would commit them to the user's soul repo in plaintext.
    const names = authSecretEnvNames(
      manifest({
        required_env: [],
        oauth: {
          flows: {},
          "x-tulipfarm": {
            client_id_env: "SLACK_CLIENT_ID",
            client_secret_env: "SLACK_CLIENT_SECRET",
            token_env: "SLACK_BOT_TOKEN",
          },
        },
      })
    );
    expect([...names].sort()).toEqual(["SLACK_BOT_TOKEN", "SLACK_CLIENT_SECRET"]);
    expect(names.has("SLACK_CLIENT_ID")).toBe(false);
  });
});

describe("authEnvNames", () => {
  it("lists every env var the flow reads or writes, in order, without duplicates", () => {
    const names = authEnvNames(
      manifest({
        auth: [
          { kind: "fields", fields: [{ name: "CID", label: "Client ID" }] },
          {
            kind: "oauth2",
            authorization_url: "https://acme.test/authorize",
            token_url: "https://acme.test/token",
            client_id_env: "CID",
            client_secret_env: "CSECRET",
            token_env: "TOKEN",
          },
          {
            kind: "install",
            url: "https://acme.test/install",
            capture: { installation_id: "INSTALL_ID" },
          },
        ],
      })
    );
    // The refresh/expiry names are derived from `token_env`, so a manifest author never declares
    // bookkeeping vars, but they still count as env the flow writes.
    expect(names).toEqual([
      "CID",
      "CSECRET",
      "TOKEN",
      "TOKEN_REFRESH_TOKEN",
      "TOKEN_EXPIRES_AT",
      "INSTALL_ID",
    ]);
  });

  it("prefers env names the manifest declares over the derived ones", () => {
    const names = authEnvNames(
      manifest({
        auth: [
          {
            kind: "oauth2",
            authorization_url: "https://acme.test/authorize",
            token_url: "https://acme.test/token",
            client_id_env: "CID",
            client_secret_env: "CSECRET",
            token_env: "TOKEN",
            refresh_token_env: "REFRESH",
            expires_at_env: "EXPIRY",
          },
        ],
      })
    );
    expect(names).toEqual(["CID", "CSECRET", "TOKEN", "REFRESH", "EXPIRY"]);
  });
});

describe("validateAuthSteps", () => {
  it("accepts a well-formed flow", () => {
    expect(
      validateAuthSteps(
        manifest({
          auth: [
            {
              kind: "fields",
              fields: [
                { name: "CID", label: "Client ID" },
                { name: "CSECRET", label: "Client secret", secret: true },
              ],
            },
            {
              kind: "oauth2",
              authorization_url: "https://acme.test/authorize",
              token_url: "https://acme.test/token",
              client_id_env: "CID",
              client_secret_env: "CSECRET",
              token_env: "TOKEN",
            },
          ],
        })
      )
    ).toEqual([]);
  });

  it("skips validation entirely for legacy manifests", () => {
    expect(validateAuthSteps(manifest({ required_env: [] }))).toEqual([]);
  });

  it("rejects an authorization_code step with no authorize URL", () => {
    const issues = validateAuthSteps(
      manifest({
        auth: [
          {
            kind: "fields",
            fields: [
              { name: "CID", label: "a" },
              { name: "CS", label: "b" },
            ],
          },
          {
            kind: "oauth2",
            token_url: "https://acme.test/token",
            client_id_env: "CID",
            client_secret_env: "CS",
            token_env: "TOKEN",
          },
        ],
      })
    );
    expect(issues).toEqual([
      "auth[1] (oauth2): authorization_url is required for the authorization_code grant",
    ]);
  });

  it("allows a client_credentials step with no authorize URL", () => {
    const issues = validateAuthSteps(
      manifest({
        auth: [
          {
            kind: "fields",
            fields: [
              { name: "CID", label: "a" },
              { name: "CS", label: "b" },
            ],
          },
          {
            kind: "oauth2",
            grant: "client_credentials",
            token_url: "https://acme.test/token",
            client_id_env: "CID",
            client_secret_env: "CS",
            token_env: "TOKEN",
          },
        ],
      })
    );
    expect(issues).toEqual([]);
  });

  it("catches an oauth2 step reading credentials no earlier step supplies", () => {
    const issues = validateAuthSteps(
      manifest({
        auth: [
          {
            kind: "oauth2",
            authorization_url: "https://acme.test/authorize",
            token_url: "https://acme.test/token",
            client_id_env: "CID",
            client_secret_env: "CSECRET",
            token_env: "TOKEN",
          },
        ],
      })
    );
    expect(issues).toEqual([
      'auth[0] (oauth2): reads "CID", which no earlier step supplies',
      'auth[0] (oauth2): reads "CSECRET", which no earlier step supplies',
    ]);
  });

  it("accepts credentials supplied by a preceding app_manifest exchange", () => {
    const issues = validateAuthSteps(
      manifest({
        auth: [
          {
            kind: "app_manifest",
            create_url: "https://github.com/settings/apps/new",
            delivery: "form_post",
            manifest_param: "manifest",
            manifest: {},
            exchange: {
              url: "https://api.github.com/app-manifests/{code}/conversions",
              map: { client_id: "CID", client_secret: "CSECRET" },
              secret_envs: ["CSECRET"],
            },
          },
          {
            kind: "oauth2",
            authorization_url: "https://github.com/login/oauth/authorize",
            token_url: "https://github.com/login/oauth/access_token",
            client_id_env: "CID",
            client_secret_env: "CSECRET",
            token_env: "TOKEN",
          },
        ],
      })
    );
    expect(issues).toEqual([]);
  });

  it("catches secret_envs naming a value the exchange never writes", () => {
    const issues = validateAuthSteps(
      manifest({
        auth: [
          {
            kind: "app_manifest",
            create_url: "https://github.com/settings/apps/new",
            delivery: "form_post",
            manifest_param: "manifest",
            manifest: {},
            exchange: { url: "https://acme.test/x", map: { id: "APP_ID" }, secret_envs: ["PEM"] },
          },
        ],
      })
    );
    expect(issues).toEqual([
      'auth[0] (app_manifest): secret_envs names "PEM", which exchange.map never writes',
    ]);
  });

  it("catches an empty fields step and a missing install URL", () => {
    const issues = validateAuthSteps(
      manifest({
        auth: [
          { kind: "fields", fields: [] },
          { kind: "install", url: "" },
        ],
      })
    );
    expect(issues).toEqual([
      "auth[0] (fields): declares no fields",
      "auth[1] (install): url missing",
    ]);
  });
});

describe("step satisfaction", () => {
  it("treats a fields step as done only when every field has a value", () => {
    const step: AuthStep = {
      kind: "fields",
      fields: [
        { name: "ID", label: "ID" },
        { name: "SECRET", label: "Secret" },
      ],
    };
    expect(authStepSatisfied(step, { ID: "a" })).toBe(false);
    expect(authStepSatisfied(step, { ID: "a", SECRET: "b" })).toBe(true);
    // An empty string is an unanswered field, not an answer.
    expect(authStepSatisfied(step, { ID: "a", SECRET: "" })).toBe(false);
  });

  it("treats a sealed secret ref as present without resolving it", () => {
    const step: AuthStep = { kind: "fields", fields: [{ name: "SECRET", label: "Secret" }] };
    expect(authStepSatisfied(step, { SECRET: "secret://integration.acme.SECRET" })).toBe(true);
  });

  it("treats an app_manifest step with no exchange as always done", () => {
    // Slack's create-app step writes nothing, so there is no value that could mark it incomplete;
    // gating "connected" on it would leave Slack permanently pending.
    const step: AuthStep = {
      kind: "app_manifest",
      create_url: "https://api.slack.com/apps",
      delivery: "query_param",
      manifest_param: "manifest_json",
      manifest: {},
    };
    expect(authStepSatisfied(step, {})).toBe(true);
  });

  it("treats an app_manifest step with an exchange as done only once it wrote its values", () => {
    const step: AuthStep = {
      kind: "app_manifest",
      create_url: "https://github.com/settings/apps/new",
      delivery: "form_post",
      manifest_param: "manifest",
      manifest: {},
      exchange: { url: "https://acme.test/x", map: { id: "APP_ID", pem: "APP_PEM" } },
    };
    expect(authStepSatisfied(step, { APP_ID: "1" })).toBe(false);
    expect(authStepSatisfied(step, { APP_ID: "1", APP_PEM: "k" })).toBe(true);
  });

  it("treats an oauth2 step as done once the token env is set", () => {
    const step: AuthStep = {
      kind: "oauth2",
      authorization_url: "https://acme.test/a",
      token_url: "https://acme.test/t",
      client_id_env: "CID",
      client_secret_env: "CSEC",
      token_env: "TOKEN",
    };
    expect(authStepSatisfied(step, { CID: "x", CSEC: "y" })).toBe(false);
    expect(authStepSatisfied(step, { TOKEN: "t" })).toBe(true);
  });

  it("reports the first unsatisfied step, walking the flow in order", () => {
    const m = manifest({
      auth: [
        { kind: "fields", fields: [{ name: "CID", label: "Client ID" }] },
        {
          kind: "oauth2",
          authorization_url: "https://acme.test/a",
          token_url: "https://acme.test/t",
          client_id_env: "CID",
          client_secret_env: "CID",
          token_env: "TOKEN",
        },
      ],
    });
    expect(nextAuthStep(m, {})).toMatchObject({ index: 0 });
    expect(nextAuthStep(m, { CID: "x" })).toMatchObject({ index: 1 });
    expect(nextAuthStep(m, { CID: "x", TOKEN: "t" })).toBeNull();
  });

  it("reports a later step even when an earlier one is still incomplete", () => {
    // The index must be the *first* gap, so a resumed flow never skips past unfinished work.
    const m = manifest({
      auth: [
        { kind: "fields", fields: [{ name: "A", label: "A" }] },
        { kind: "fields", fields: [{ name: "B", label: "B" }] },
      ],
    });
    expect(nextAuthStep(m, { B: "set" })).toMatchObject({ index: 0 });
  });

  it("counts a manifest that declares no credentials as connected", () => {
    expect(authFlowSatisfied(manifest(), {})).toBe(true);
  });

  it("counts a legacy required_env manifest as connected only when its vars are set", () => {
    const m = manifest({ required_env: [{ name: "API_KEY", label: "API key" }] });
    expect(authFlowSatisfied(m, {})).toBe(false);
    expect(authFlowSatisfied(m, { API_KEY: "k" })).toBe(true);
  });
});

describe("authStepProducesEnv", () => {
  // `authStepSatisfied` answers "does this step still owe credentials?", which is the wrong
  // question for a setup walkthrough: a step that writes nothing is satisfied before it is ever
  // started. A caller driving an operator through the flow needs to know which steps it can
  // actually observe finishing, or it will skip the ones it cannot.

  it("reports a fields step as observable only when it asks for something", () => {
    expect(authStepProducesEnv({ kind: "fields", fields: [{ name: "ID", label: "ID" }] })).toBe(
      true
    );
    expect(authStepProducesEnv({ kind: "fields", fields: [] })).toBe(false);
  });

  it("reports an app_manifest step with no exchange as unobservable", () => {
    // Slack's create-app step: Slack has no manifest-to-credentials API, so nothing comes back
    // and no value will ever prove the operator did it. This is the case that made the setup UI
    // skip step 1 when it trusted `authStepSatisfied` alone.
    const step: AuthStep = {
      kind: "app_manifest",
      create_url: "https://api.slack.com/apps",
      delivery: "query_param",
      manifest_param: "manifest_json",
      manifest: {},
    };
    expect(authStepSatisfied(step, {})).toBe(true);
    expect(authStepProducesEnv(step)).toBe(false);
  });

  it("reports an app_manifest step with an exchange as observable", () => {
    expect(
      authStepProducesEnv({
        kind: "app_manifest",
        create_url: "https://github.com/settings/apps/new",
        delivery: "form_post",
        manifest_param: "manifest",
        manifest: {},
        exchange: { url: "https://acme.test/x", map: { id: "APP_ID" } },
      })
    ).toBe(true);
  });

  it("reports every oauth2 step as observable", () => {
    // An oauth2 step always writes `token_env`, so there is no unobservable variant.
    expect(
      authStepProducesEnv({
        kind: "oauth2",
        authorization_url: "https://acme.test/a",
        token_url: "https://acme.test/t",
        client_id_env: "CID",
        client_secret_env: "CSEC",
        token_env: "TOKEN",
      })
    ).toBe(true);
  });

  it("reports an install step as observable only when it captures callback values", () => {
    const url = "https://acme.test/install";
    expect(
      authStepProducesEnv({ kind: "install", url, capture: { installation_id: "INST" } })
    ).toBe(true);
    expect(authStepProducesEnv({ kind: "install", url })).toBe(false);
  });
});

describe("webhook auth steps", () => {
  const tokenStep: AuthStep = {
    kind: "fields",
    fields: [{ name: "TELEGRAM_BOT_TOKEN", label: "Bot token", secret: true }],
  };
  const registerStep: AuthStep = {
    kind: "webhook",
    url: "https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/setWebhook",
    secret_env: "TELEGRAM_WEBHOOK_SECRET",
    body: { url: "{webhook_url}", secret_token: "{TELEGRAM_WEBHOOK_SECRET}" },
  };
  const ingress: IntegrationManifest["ingress"] = {
    handler: "ingress.ts",
    webhook: {
      security: {
        type: "shared_secret",
        header: "X-Telegram-Bot-Api-Secret-Token",
        secret_env: "TELEGRAM_WEBHOOK_SECRET",
      },
    },
  };

  it("seals the generated delivery secret", () => {
    // It is ours, not the provider's: leaking it lets anyone forge deliveries as the provider.
    expect(authSecretEnvNames(manifest({ auth: [tokenStep, registerStep] }))).toContain(
      "TELEGRAM_WEBHOOK_SECRET"
    );
  });

  it("reports the env it reads and writes", () => {
    expect(authEnvNames(manifest({ auth: [tokenStep, registerStep] }))).toEqual([
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_WEBHOOK_SECRET",
    ]);
  });

  it("is unfinished until the secret exists, and finished once it does", () => {
    expect(authStepSatisfied(registerStep, {})).toBe(false);
    expect(authStepSatisfied(registerStep, { TELEGRAM_WEBHOOK_SECRET: "s" })).toBe(true);
    expect(authStepProducesEnv(registerStep)).toBe(true);
  });

  it("accepts a flow whose registration and verification name the same secret", () => {
    expect(validateAuthSteps(manifest({ auth: [tokenStep, registerStep], ingress }))).toEqual([]);
  });

  it("rejects registering under one secret name and verifying under another", () => {
    // Otherwise every delivery fails signature checks — a failure that looks like the provider's
    // fault and never resolves on its own.
    const issues = validateAuthSteps(
      manifest({
        auth: [tokenStep, { ...registerStep, secret_env: "OTHER_SECRET" }],
        ingress,
      })
    );
    expect(
      issues.some((issue) =>
        /registers secret_env "OTHER_SECRET".*verifies "TELEGRAM_WEBHOOK_SECRET"/.test(issue)
      )
    ).toBe(true);
    // The renamed secret also stops supplying the body template that referenced it.
    expect(issues.some((issue) => issue.includes('reads "TELEGRAM_WEBHOOK_SECRET"'))).toBe(true);
  });

  it("rejects a step whose template reads an env var nothing supplies", () => {
    const issues = validateAuthSteps(manifest({ auth: [registerStep] }));
    expect(issues).toEqual([
      'auth[0] (webhook): reads "TELEGRAM_BOT_TOKEN", which no earlier step supplies',
    ]);
  });

  it("treats {webhook_url} as supplied by the host, not by a step", () => {
    const issues = validateAuthSteps(
      manifest({
        auth: [{ kind: "webhook", url: "https://acme.test/hook", body: { u: "{webhook_url}" } }],
      })
    );
    expect(issues).toEqual([]);
  });

  it("rejects a step with no url", () => {
    expect(validateAuthSteps(manifest({ auth: [{ kind: "webhook", url: "" }] }))).toEqual([
      "auth[0] (webhook): url missing",
    ]);
  });
});

describe("validateIngressContextEnv", () => {
  const ingress = (context_env: string[]) =>
    ({
      handler: "ingress.ts",
      webhook: { security: { type: "shared_secret", header: "X-Secret", secret_env: "OTHER" } },
      context_env,
    }) satisfies NonNullable<IntegrationManifest["ingress"]>;

  it("accepts configuration vars", () => {
    expect(
      validateIngressContextEnv(
        manifest({
          auth: [{ kind: "fields", fields: [{ name: "BOT_USERNAME", label: "Bot username" }] }],
          ingress: ingress(["BOT_USERNAME"]),
        })
      )
    ).toEqual([]);
  });

  it("rejects a var the flow stores as a secret", () => {
    const issues = validateIngressContextEnv(
      manifest({
        auth: [{ kind: "fields", fields: [{ name: "BOT_TOKEN", label: "Token", secret: true }] }],
        ingress: ingress(["BOT_TOKEN"]),
      })
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("BOT_TOKEN");
  });

  it("rejects a webhook step secret, which never passes through a form", () => {
    const issues = validateIngressContextEnv(
      manifest({
        auth: [
          {
            kind: "webhook",
            title: "Register webhook",
            url: "https://api.example.com/setWebhook",
            secret_env: "WEBHOOK_SECRET",
          },
        ],
        ingress: ingress(["WEBHOOK_SECRET"]),
      })
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("WEBHOOK_SECRET");
  });

  it("is a no-op when no context is declared", () => {
    expect(validateIngressContextEnv(manifest({ ingress: ingress([]) }))).toEqual([]);
    expect(validateIngressContextEnv(manifest())).toEqual([]);
  });
});
