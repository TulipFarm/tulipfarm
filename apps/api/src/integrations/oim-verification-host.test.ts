import {
  createOimFixturePaginationRuntime,
  type EgressHttpPort,
  type EgressHttpRequest,
} from "@tulipfarm/integrations";
import type { OimManifest } from "@tulipfarm/schema";
import type { ConnectionAuthStep, PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { createOimVerificationHost } from "./oim-verification-host";

const manifest: OimManifest = {
  oimVersion: "1.0",
  kind: "Integration",
  metadata: {
    id: "facebook",
    name: "Facebook Pages",
    version: "2.0.0",
    description: "Verify one exact Page.",
    license: "Apache-2.0",
  },
  profiles: { core: "1.1", auth: "1.1" },
  auth: {
    credentialSlots: [
      { id: "user_token", label: "User token", kind: "bearer_token", required: true },
      { id: "page_token", label: "Page token", kind: "bearer_token", required: true },
    ],
    configurationFields: [{ id: "page_id", label: "Page ID", type: "string", required: true }],
    steps: [
      {
        id: "tokens",
        title: "Connect",
        type: "fields",
        fields: [
          {
            id: "user_token",
            label: "User token",
            input: "password",
            required: true,
            target: { type: "credential", slot: "user_token" },
          },
          {
            id: "page_token",
            label: "Page token",
            input: "password",
            required: true,
            target: { type: "credential", slot: "page_token" },
          },
          {
            id: "page_id",
            label: "Page ID",
            input: "text",
            required: true,
            target: { type: "configuration", field: "page_id" },
          },
        ],
      },
    ],
    verification: {
      issuer: { source: "package", value: "https://facebook.com" },
      checks: [
        {
          id: "authorized-pages",
          operationId: "list-pages",
          credentialSlots: ["user_token"],
          success: [{ kind: "present", path: "/data" }],
        },
        {
          id: "current-page",
          operationId: "current-page",
          credentialSlots: ["page_token"],
          success: [
            { kind: "present", path: "/id" },
            { kind: "present", path: "/category" },
          ],
        },
      ],
      comparisons: [
        {
          kind: "equals",
          left: { source: "response", checkId: "current-page", path: "/id" },
          right: { source: "configuration", field: "page_id" },
        },
        {
          kind: "array_contains",
          array: { source: "response", checkId: "authorized-pages", path: "/data" },
          itemPath: "/id",
          value: { source: "configuration", field: "page_id" },
        },
      ],
      evidence: {
        assurance: "identified",
        subject: {
          kind: "account",
          checkId: "current-page",
          path: "/id",
          namespace: "issuer",
        },
        tenant: {
          kind: "account",
          source: "response",
          checkId: "current-page",
          path: "/id",
        },
      },
    },
  },
  operations: [
    {
      id: "list-pages",
      name: "facebook_list_pages",
      description: "List authorized Pages.",
      effect: "read",
      identityMode: "shared_only",
      credentialSlot: "user_token",
      credentialInjection: { in: "query", name: "access_token", format: "{token}" },
      source: {
        type: "http",
        method: "GET",
        baseUrl: "https://graph.facebook.com",
        path: "/v25.0/me/accounts",
      },
      pagination: {
        type: "cursor",
        requestParameter: "after",
        responsePath: "/paging/cursors/after",
        itemsPath: "/data",
      },
      response: {
        schema: { type: "object" },
        maxBytes: 16_384,
      },
    },
    {
      id: "current-page",
      name: "facebook_current_page",
      description: "Read the current Page.",
      effect: "read",
      identityMode: "shared_only",
      credentialSlot: "page_token",
      credentialInjection: { in: "query", name: "access_token", format: "{token}" },
      source: {
        type: "http",
        method: "GET",
        baseUrl: "https://graph.facebook.com",
        path: "/v25.0/me",
      },
      response: {
        schema: { type: "object" },
        maxBytes: 16_384,
      },
    },
  ],
};

const connection: PersistedConnection = {
  businessId: "business-1",
  id: "connection-1",
  integration: { id: "facebook", majorVersion: 2 },
  label: "Page",
  owner: { scope: "organization" },
  status: "active",
  isDefault: true,
  configuration: { page_id: "page-2" },
  agentVisibleConfiguration: [],
  secretBindings: {
    user_token: "secret://00000000-0000-4000-8000-000000000001",
    page_token: "secret://00000000-0000-4000-8000-000000000002",
  },
  health: { status: "healthy", checkedAt: "2026-09-12T12:00:00.000Z" },
  expiresAt: null,
  createdAt: new Date("2026-09-12T12:00:00.000Z"),
  updatedAt: new Date("2026-09-12T12:00:00.000Z"),
};

const authStep: ConnectionAuthStep = {
  businessId: "business-1",
  connectionId: "connection-1",
  stepId: "tokens",
  status: "active",
  accessSlot: null,
  accessSecretRef: null,
  refreshSlot: null,
  refreshSecretRef: null,
  externalIdentity: null,
  expiresAt: null,
  healthCheckedAt: "2026-09-12T12:00:00.000Z",
  revision: 3,
  createdAt: "2026-09-12T12:00:00.000Z",
  updatedAt: "2026-09-12T12:00:00.000Z",
};

class FacebookHttp implements EgressHttpPort {
  readonly sent: EgressHttpRequest[] = [];

  async send(request: EgressHttpRequest) {
    this.sent.push(request);
    if (request.url.includes("/me/accounts") && !request.url.includes("after=")) {
      return {
        status: 200,
        headers: {},
        body: {
          data: [{ id: "page-1" }],
          paging: { cursors: { after: "second-page" } },
        },
      };
    }
    if (request.url.includes("/me/accounts")) {
      return {
        status: 200,
        headers: {},
        body: { data: [{ id: "page-2" }] },
      };
    }
    return {
      status: 200,
      headers: {},
      body: { id: "page-2", name: "Muskan Bakery", category: "Bakery" },
    };
  }
}

describe("createOimVerificationHost", () => {
  it("verifies every credential slot and walks all membership pages", async () => {
    const http = new FacebookHttp();
    const host = createOimVerificationHost({
      authSteps: { list: async () => [authStep] },
      credentials: {
        read: async (reference) => (reference.endsWith("1") ? "user-secret" : "page-secret"),
      },
      http,
      paginationRuntime: createOimFixturePaginationRuntime(),
      now: () => new Date("2026-09-12T12:00:00.000Z"),
    });

    const evidence = await host.verify({
      package: {
        key: "facebook-v2",
        manifest,
        packageDigest: "a".repeat(64),
        identity: { id: "facebook", majorVersion: 2 },
      },
      connection,
    });

    expect(evidence).toMatchObject({
      assurance: "identified",
      subject: { id: "page-2", kind: "account" },
      tenant: { id: "page-2", kind: "account" },
      binding: {
        connectionId: "connection-1",
        packageDigest: "a".repeat(64),
        authSteps: [
          {
            stepId: "tokens",
            revision: 3,
            credentials: [{ slot: "page_token" }, { slot: "user_token" }],
          },
        ],
      },
    });
    expect(http.sent).toHaveLength(3);
    expect(http.sent[0]?.url).toContain("access_token=user-secret");
    expect(http.sent[1]?.url).toContain("after=second-page");
    expect(http.sent[2]?.url).toContain("access_token=page-secret");
  });

  it("fails when exact Page verification does not match", async () => {
    const host = createOimVerificationHost({
      authSteps: { list: async () => [authStep] },
      credentials: { read: async () => "secret" },
      http: {
        async send(request) {
          return request.url.includes("/me/accounts")
            ? { status: 200, headers: {}, body: { data: [{ id: "other-page" }] } }
            : {
                status: 200,
                headers: {},
                body: { id: "page-2", name: "Muskan Bakery", category: "Bakery" },
              };
        },
      },
      paginationRuntime: createOimFixturePaginationRuntime(),
    });

    await expect(
      host.verify({
        package: {
          key: "facebook-v2",
          manifest,
          packageDigest: "a".repeat(64),
          identity: { id: "facebook", majorVersion: 2 },
        },
        connection,
      })
    ).rejects.toThrow("comparison_failed");
  });
});
