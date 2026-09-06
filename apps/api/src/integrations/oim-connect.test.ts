import type { OimManifest } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type { ConnectionStore } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import {
  createOimConnection,
  OimConnectError,
  oimConnectForm,
  oimConnectSupported,
} from "./oim-connect";

function manifest(overrides: Partial<OimManifest> = {}): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "acme",
      name: "Acme",
      version: "2.3.1",
      description: "Do acme things.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0" },
    auth: {
      credentialSlots: [{ id: "api_token", label: "API token", kind: "api_key", required: true }],
      configurationFields: [
        { id: "site", label: "Site host", type: "url", required: true, agentVisible: true },
        { id: "page_size", label: "Page size", type: "integer" },
      ],
      allowedOriginHosts: ["*.acme.test"],
      steps: [
        {
          id: "token",
          title: "Paste an API token",
          type: "fields",
          fields: [
            {
              id: "token",
              label: "API token",
              input: "password",
              target: { type: "credential", slot: "api_token" },
            },
            {
              id: "site",
              label: "Site",
              input: "url",
              target: { type: "configuration", field: "site" },
            },
            {
              id: "page_size",
              label: "Page size",
              input: "text",
              required: false,
              target: { type: "configuration", field: "page_size" },
            },
          ],
        },
      ],
    },
    operations: [
      {
        id: "read-thing",
        name: "read_thing",
        description: "Read a thing.",
        effect: "read",
        identityMode: "shared_only",
        credentialSlot: "api_token",
        credentialInjection: { in: "header", name: "Authorization", format: "Bearer {credential}" },
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://{site}",
          path: "/api/thing",
        },
        response: { schema: { type: "object" }, maxBytes: 4_096 },
      },
    ],
    ...overrides,
  } as OimManifest;
}

function stubs() {
  const secrets = new Map<string, string>();
  const written: Parameters<ConnectionStore["put"]>[1][] = [];
  let counter = 0;
  return {
    secrets,
    written,
    deps: {
      connections: {
        put: async (_businessId: string, connection: Parameters<ConnectionStore["put"]>[1]) => {
          written.push(connection);
        },
      } as Pick<ConnectionStore, "put">,
      secrets: {
        set: async (key: string, value: string) => {
          secrets.set(key, value);
        },
      } as unknown as SecretsService,
      newId: () => `id${++counter}`,
    },
  };
}

const base = {
  businessId: "biz",
  label: "Acme prod",
  owner: { scope: "organization" as const },
};

describe("oimConnectForm", () => {
  it("derives one input per declared auth field and marks credentials secret", () => {
    const form = oimConnectForm(manifest());
    expect(form).toMatchObject({ integrationId: "acme", majorVersion: 2 });
    expect(form.steps[0]?.fields).toEqual([
      { id: "token", label: "API token", input: "password", required: true, secret: true },
      { id: "site", label: "Site", input: "url", required: true, secret: false },
      { id: "page_size", label: "Page size", input: "text", required: false, secret: false },
    ]);
  });

  it("treats an oauth2 step as runnable but flags that consent still has to happen", () => {
    const oauth = manifest();
    const auth = oauth.auth;
    if (auth === undefined) throw new Error("fixture has auth");
    const withOauth = manifest({
      auth: {
        ...auth,
        steps: [
          {
            id: "signin",
            title: "Sign in",
            type: "oauth2",
            authorizationUrl: "https://acme.test/authorize",
            tokenUrl: "https://acme.test/token",
            scopes: ["read"],
            clientId: { type: "credential", slot: "api_token" },
            bindings: [
              { sourcePath: "/access_token", target: { type: "credential", slot: "api_token" } },
            ],
          },
        ],
      },
    });

    expect(oimConnectForm(withOauth).unsupportedStepTypes).toEqual([]);
    expect(oimConnectForm(withOauth).requiresAuthorization).toBe(true);
    expect(oimConnectSupported(withOauth)).toBe(true);
  });

  it("treats a webhook step as automatic setup rather than an unsupported form step", () => {
    const base = manifest();
    const auth = base.auth;
    if (auth === undefined) throw new Error("fixture has auth");
    const withWebhook = manifest({
      auth: {
        ...auth,
        credentialSlots: [
          ...auth.credentialSlots,
          { id: "webhook_secret", label: "Webhook secret", kind: "webhook_secret" },
        ],
        steps: [
          ...auth.steps,
          {
            id: "webhook",
            title: "Register webhook",
            type: "webhook",
            operationId: "register_webhook",
            unregisterOperationId: "unregister_webhook",
            subscriptionIdPath: "/id",
            secretSlot: "webhook_secret",
            registration: { callbackUrl: { in: "body", pointer: "/callback_url" } },
            unregistration: { subscriptionId: { in: "body", pointer: "/id" } },
          },
        ],
      },
    });

    expect(oimConnectForm(withWebhook).unsupportedStepTypes).toEqual([]);
    expect(oimConnectSupported(withWebhook)).toBe(true);
  });

  it("names step types it cannot run rather than presenting an empty form as complete", () => {
    const base = manifest();
    const auth = base.auth;
    if (auth === undefined) throw new Error("fixture has auth");
    const withInstall = manifest({
      auth: {
        ...auth,
        steps: [
          {
            id: "install",
            title: "Install the app",
            type: "install",
            url: "https://acme.test/install",
            bindings: [
              { sourcePath: "/app_id", target: { type: "credential", slot: "api_token" } },
            ],
          },
        ],
      },
    });
    expect(oimConnectForm(withInstall).unsupportedStepTypes).toEqual(["install"]);
    expect(oimConnectSupported(withInstall)).toBe(false);
  });
});

describe("createOimConnection", () => {
  it("writes credentials as Secrets and configuration onto the Connection", async () => {
    const { secrets, written, deps } = stubs();
    const result = await createOimConnection(deps, {
      ...base,
      manifest: manifest(),
      values: { token: "t0ken", site: "https://team.acme.test", page_size: "50" },
    });

    expect(result.connectionId).toBe("id2");
    expect([...secrets.values()]).toEqual(["t0ken"]);
    const connection = written[0];
    expect(connection).toMatchObject({
      integration: { id: "acme", majorVersion: 2 },
      label: "Acme prod",
      status: "active",
      configuration: { site: "team.acme.test", page_size: 50 },
      agentVisibleConfiguration: ["site"],
    });
    // The Connection binds a `secret://` reference, never the value itself.
    expect(connection?.secretBindings.api_token).toMatch(/^secret:\/\/oim-acme-id1$/);
  });

  it("creates the generated Secret required by a webhook-only package", async () => {
    const { secrets, written, deps } = stubs();
    const baseManifest = manifest();
    if (baseManifest.auth === undefined) throw new Error("fixture has auth");
    const webhookManifest = manifest({
      auth: {
        ...baseManifest.auth,
        credentialSlots: [
          { id: "delivery_secret", label: "Delivery secret", kind: "webhook_secret" },
        ],
        steps: [
          {
            id: "webhook",
            title: "Receive events",
            type: "webhook",
            operationId: "register_webhook",
            unregisterOperationId: "unregister_webhook",
            subscriptionIdPath: "/id",
            secretSlot: "delivery_secret",
            registration: {
              callbackUrl: { in: "body", pointer: "/callback_url" },
              secret: { in: "body", pointer: "/secret" },
            },
            unregistration: { subscriptionId: { in: "body", pointer: "/subscription_id" } },
          },
        ],
      },
    });

    await createOimConnection(deps, {
      ...base,
      manifest: webhookManifest,
      values: {},
    });

    expect([...secrets.values()]).toHaveLength(1);
    expect(written[0]?.secretBindings.delivery_secret).toMatch(
      /^secret:\/\/oim-delivery-acme-id1$/
    );
  });

  it("stores a bare host as typed, matching what the compiler will interpolate", async () => {
    const { written, deps } = stubs();
    await createOimConnection(deps, {
      ...base,
      manifest: manifest(),
      values: { token: "t", site: "team.acme.test" },
    });
    expect(written[0]?.configuration.site).toBe("team.acme.test");
  });

  it("refuses a host the package is not allowed to reach", async () => {
    const { deps, written } = stubs();
    await expect(
      createOimConnection(deps, {
        ...base,
        manifest: manifest(),
        values: { token: "t0ken", site: "https://evil.test" },
      })
    ).rejects.toMatchObject({ code: "origin_not_allowed" });
    expect(written).toHaveLength(0);
  });

  it("refuses a missing required field before writing anything", async () => {
    const { deps, secrets } = stubs();
    await expect(
      createOimConnection(deps, { ...base, manifest: manifest(), values: { token: "t0ken" } })
    ).rejects.toBeInstanceOf(OimConnectError);
    expect(secrets.size).toBe(0);
  });

  it("refuses a field the package never declared", async () => {
    const { deps } = stubs();
    await expect(
      createOimConnection(deps, {
        ...base,
        manifest: manifest(),
        values: { token: "t", site: "https://a.acme.test", smuggled: "x" },
      })
    ).rejects.toMatchObject({ code: "unknown_field", detail: "smuggled" });
  });

  it("refuses a package whose sign-in flow this runtime cannot run", async () => {
    const { deps } = stubs();
    const auth = manifest().auth;
    if (auth === undefined) throw new Error("fixture has auth");
    await expect(
      createOimConnection(deps, {
        ...base,
        manifest: manifest({
          auth: {
            ...auth,
            steps: [
              {
                id: "install",
                title: "Install the app",
                type: "install",
                url: "https://acme.test/install",
                bindings: [
                  { sourcePath: "/token", target: { type: "credential", slot: "api_token" } },
                ],
              },
            ],
          },
        }),
        values: {},
      })
    ).rejects.toMatchObject({ code: "unsupported_auth", detail: "install" });
  });
});
