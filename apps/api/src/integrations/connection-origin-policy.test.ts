import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compileOimHttpOperations, GuardedEgressHttp } from "@tulipfarm/integrations";
import { type OimConnection, type OimManifest, parseOimManifest } from "@tulipfarm/schema";
import type { PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import {
  type ConnectionOriginApproval,
  ConnectionOriginPolicyError,
  canonicalApprovedPublicOrigin,
  connectionOriginApprovalForTrustedConfirmation,
  createOimApprovedOriginResolver,
  manifestForApprovedConnectionOrigin,
  oimConnectionOriginRequiresApproval,
} from "./connection-origin-policy";

const ROOT = join(__dirname, "..", "..", "..", "..", "integrations");

async function shipped(path: string): Promise<OimManifest> {
  return parseOimManifest(await readFile(join(ROOT, path, "oim.yml"), "utf8"));
}

function connection(
  manifest: OimManifest,
  field: string,
  value: string,
  overrides: Partial<OimConnection> = {}
): OimConnection {
  return {
    id: "connection-1",
    integration: {
      id: manifest.metadata.id,
      majorVersion: Number(manifest.metadata.version.split(".", 1)[0]),
    },
    label: "Self-hosted",
    owner: { scope: "organization" },
    status: "active",
    isDefault: false,
    configuration: { [field]: value },
    agentVisibleConfiguration: [field],
    secretBindings: {},
    health: { status: "unknown", checkedAt: null },
    expiresAt: null,
    ...overrides,
  };
}

function approval(
  manifest: OimManifest,
  target: OimConnection,
  field: string,
  origin: string
): ConnectionOriginApproval {
  return connectionOriginApprovalForTrustedConfirmation({
    manifest,
    connection: { ...target, configuration: { [field]: origin } },
    configurationField: field,
    approvedBy: "operator-1",
    approvedAt: "2026-09-07T06:30:00.000Z",
  });
}

function persisted(target: OimConnection): PersistedConnection {
  return {
    ...target,
    businessId: "business-1",
    createdAt: new Date("2026-09-07T06:00:00.000Z"),
    updatedAt: new Date("2026-09-07T06:00:00.000Z"),
  };
}

describe("approved self-hosted Connection origins", () => {
  it("identifies only declared policy fields that drive an operation origin", async () => {
    const gitlab = await shipped("gitlab");
    const cloudConfluence = await shipped("confluence");
    if (gitlab.auth === undefined) throw new Error("GitLab fixture has no auth declaration");

    expect(oimConnectionOriginRequiresApproval(gitlab, "gitlab_host")).toBe(true);
    expect(oimConnectionOriginRequiresApproval(gitlab, "other_host")).toBe(false);
    expect(oimConnectionOriginRequiresApproval(cloudConfluence, "site")).toBe(false);
    expect(
      oimConnectionOriginRequiresApproval(
        {
          ...gitlab,
          auth: {
            ...gitlab.auth,
            configurationFields: [
              ...(gitlab.auth.configurationFields ?? []),
              { id: "unused_host", label: "Unused host", type: "string" },
            ],
          },
          extensions: {
            ...gitlab.extensions,
            "x-tulipfarm-origin-policy": {
              mode: "approved_public_exact",
              fields: ["gitlab_host", "unused_host"],
            },
          },
        },
        "unused_host"
      )
    ).toBe(false);
    expect(
      oimConnectionOriginRequiresApproval(
        {
          ...gitlab,
          auth: {
            ...gitlab.auth,
            configurationFields: (gitlab.auth.configurationFields ?? []).filter(
              (field) => field.id !== "gitlab_host"
            ),
          },
        },
        "gitlab_host"
      )
    ).toBe(false);
  });

  it("compiles GitLab against one exact approved public origin", async () => {
    const manifest = await shipped("gitlab");
    const target = connection(manifest, "gitlab_host", "gitlab.example.com");
    const approved = manifestForApprovedConnectionOrigin({
      manifest,
      connection: target,
      approval: approval(manifest, target, "gitlab_host", "https://gitlab.example.com"),
    });

    const tools = compileOimHttpOperations(approved, target.configuration);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.binding.baseUrl).toBe("https://gitlab.example.com");
      expect(tool.contract.spec.allowedDestinations).toEqual(["gitlab.example.com"]);
    }
  });

  it("compiles the distinct Confluence Data Center REST v1 package", async () => {
    const manifest = await shipped("confluence-data-center");
    const target = connection(manifest, "site_origin", "https://docs.example.com");
    const approved = manifestForApprovedConnectionOrigin({
      manifest,
      connection: target,
      approval: approval(manifest, target, "site_origin", "docs.example.com"),
    });

    const tools = compileOimHttpOperations(approved, target.configuration);
    expect(tools.map((tool) => tool.binding.pathTemplate)).toEqual([
      "/rest/api/user/current",
      "/rest/api/space",
      "/rest/api/content",
      "/rest/api/content/{id}",
    ]);
    expect(
      tools.every(
        (tool) =>
          tool.binding.auth?.in === "header" && tool.binding.auth.format === "Bearer {token}"
      )
    ).toBe(true);
  });

  it("denies an unapproved host and a changed configured origin", async () => {
    const manifest = await shipped("gitlab");
    const approvedTarget = connection(manifest, "gitlab_host", "gitlab.example.com");
    const confirmed = approval(manifest, approvedTarget, "gitlab_host", "gitlab.example.com");

    expect(() => compileOimHttpOperations(manifest, approvedTarget.configuration)).toThrow(
      expect.objectContaining({ code: "origin_not_allowed" })
    );
    expect(() =>
      manifestForApprovedConnectionOrigin({
        manifest,
        connection: connection(manifest, "gitlab_host", "gitlab.attacker.example"),
        approval: confirmed,
      })
    ).toThrow(new ConnectionOriginPolicyError("approval_mismatch"));
  });

  it("denies private, local and non-origin approval values", () => {
    for (const value of [
      "10.0.0.5",
      "https://127.0.0.1",
      "https://gitlab.internal",
      "https://gitlab.example.com:8443",
      "https://gitlab.example.com/a/path",
    ]) {
      expect(() => canonicalApprovedPublicOrigin(value), value).toThrow(
        new ConnectionOriginPolicyError("origin_invalid")
      );
    }
  });

  it("keeps the request-time DNS cage after approval", async () => {
    const manifest = await shipped("gitlab");
    const target = connection(manifest, "gitlab_host", "gitlab.example.com");
    const approved = manifestForApprovedConnectionOrigin({
      manifest,
      connection: target,
      approval: approval(manifest, target, "gitlab_host", "gitlab.example.com"),
    });
    const tool = compileOimHttpOperations(approved, target.configuration)[0];
    if (tool === undefined) throw new Error("GitLab fixture has no operation");
    const inner = { send: vi.fn() };
    const guarded = new GuardedEgressHttp(inner, {
      resolve: async () => ["169.254.169.254"],
    });

    await expect(
      guarded.send({
        method: "GET",
        url: new URL(tool.binding.pathTemplate, tool.binding.baseUrl).toString(),
        headers: { "PRIVATE-TOKEN": "fixture" },
      })
    ).resolves.toMatchObject({
      status: 403,
      body: { error: "private_destination" },
    });
    expect(inner.send).not.toHaveBeenCalled();
  });

  it("cannot broaden an arbitrary Cloud provider allowlist", async () => {
    const manifest = await shipped("confluence");
    const target = connection(manifest, "site", "confluence.example.com");
    expect(() =>
      manifestForApprovedConnectionOrigin({
        manifest,
        connection: target,
        approval: approval(manifest, target, "site", "confluence.example.com"),
      })
    ).toThrow(new ConnectionOriginPolicyError("policy_not_declared"));
  });

  it("cannot approve a field the self-host policy did not name", async () => {
    const manifest = await shipped("gitlab");
    const target = connection(manifest, "other_host", "gitlab.example.com");
    expect(() =>
      connectionOriginApprovalForTrustedConfirmation({
        manifest,
        connection: target,
        configurationField: "other_host",
        approvedBy: "operator-1",
        approvedAt: "2026-09-07T06:30:00.000Z",
      })
    ).toThrow(new ConnectionOriginPolicyError("policy_not_declared"));
  });

  it("loads trusted approval for the exact operation and applies only its approved host", async () => {
    const manifest = await shipped("gitlab");
    const target = connection(manifest, "gitlab_host", "gitlab.example.com");
    const confirmed = approval(manifest, target, "gitlab_host", "gitlab.example.com");
    const get = vi.fn(async () => confirmed);
    const resolver = createOimApprovedOriginResolver({ get });
    const operation = manifest.operations[0];
    if (operation === undefined) throw new Error("GitLab fixture has no operation");

    const approved = await resolver.manifestForOperation({
      businessId: "business-1",
      manifest,
      operation,
      connection: persisted(target),
    });

    expect(get).toHaveBeenCalledWith("business-1", "connection-1", "gitlab_host");
    expect(approved.auth?.allowedOriginHosts).toEqual([
      "gitlab.com",
      "*.gitlab.com",
      "gitlab.example.com",
    ]);
    expect(manifest.auth?.allowedOriginHosts).toEqual(["gitlab.com", "*.gitlab.com"]);
  });

  it("fails closed when a policy-bound operation has no trusted approval", async () => {
    const manifest = await shipped("gitlab");
    const target = connection(manifest, "gitlab_host", "gitlab.example.com");
    const resolver = createOimApprovedOriginResolver({ get: async () => null });
    const operation = manifest.operations[0];
    if (operation === undefined) throw new Error("GitLab fixture has no operation");

    await expect(
      resolver.manifestForOperation({
        businessId: "business-1",
        manifest,
        operation,
        connection: persisted(target),
      })
    ).rejects.toEqual(new ConnectionOriginPolicyError("approval_missing"));
  });

  it("returns the original manifest without reading approval for a static operation", async () => {
    const manifest = await shipped("confluence");
    const target = connection(manifest, "site", "example.atlassian.net");
    const get = vi.fn(async () => null);
    const resolver = createOimApprovedOriginResolver({ get });
    const operation = manifest.operations[0];
    if (operation === undefined) throw new Error("Confluence fixture has no operation");

    await expect(
      resolver.manifestForOperation({
        businessId: "business-1",
        manifest,
        operation,
        connection: persisted(target),
      })
    ).resolves.toBe(manifest);
    expect(get).not.toHaveBeenCalled();
  });
});
