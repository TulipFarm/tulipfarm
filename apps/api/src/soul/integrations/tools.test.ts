import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { oimFileDigest } from "@tulipfarm/schema";
import type { GitSyncService, SoulWriteRequest, SoulWriter } from "@tulipfarm/soul";
import { SoulWriteError } from "@tulipfarm/soul";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetIntegrationDrafts } from "./drafts";
import { INTEGRATION_AUTHORING_TOOLS, type IntegrationAuthoringToolContext } from "./tools";

function getTool(name: string) {
  const tool = INTEGRATION_AUTHORING_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`tool not found: ${name}`);
  return tool;
}

const reviewTool = getTool("integration_draft_review");
const createTool = getTool("integration_draft_create");
const getIntegrationTool = getTool("integration_get");
const listTool = getTool("integration_list");

const HEAD = `oimVersion: "1.0"
kind: Integration

metadata:
  id: acme-status
  name: Acme Status
  version: 1.0.0
  description: Read the current Acme service status.
  license: MIT

profiles:
  core: "1.0"
`;

const OPERATIONS = `
operations:
  - id: status
    name: acme_status
    description: Read the current Acme service status.
    effect: read
    identityMode: shared_only
    source:
      type: http
      method: GET
      baseUrl: https://status.acme.com
      path: /api/v2/status.json
    response:
      maxBytes: 65536
      schema:
        type: object
        properties:
          status:
            type: object
            properties:
              description: { type: string }
      projection:
        - /status/description
`;

const MANIFEST = HEAD + OPERATIONS;

const PASSING_FIXTURE = `version: 1
cases:
  - name: gets-status
    operationId: status
    request: {}
    response:
      status: 200
      body:
        status:
          description: All systems operational
    expect:
      request:
        method: GET
        url: https://status.acme.com/api/v2/status.json
      result:
        status:
          description: All systems operational
`;

function withFiles(
  files: readonly { path: string; role: "fixture" | "guide"; content: string }[],
  manifest = MANIFEST
): string {
  return `${manifest}
files:
${files
  .map(
    (file) => `  - path: ${file.path}
    role: ${file.role}
    sha256: "${oimFileDigest(file.content)}"`
  )
  .join("\n")}
`;
}

async function makeContext(initialLock?: Record<string, unknown>): Promise<{
  context: IntegrationAuthoringToolContext;
  applied: SoulWriteRequest[];
  root: string;
  readLock: () => Record<string, unknown>;
  releaseTrust: NonNullable<IntegrationAuthoringToolContext["releaseTrust"]>;
}> {
  const soul = await mkdtemp(join(tmpdir(), "oim-authoring-"));
  const applied: SoulWriteRequest[] = [];
  let lock = initialLock === undefined ? "" : `${JSON.stringify(initialLock)}\n`;
  let commit = 0;
  let provenance: Awaited<
    ReturnType<NonNullable<IntegrationAuthoringToolContext["releaseTrust"]>["installedProvenance"]>
  > = null;
  const soulWriter = {
    read: vi.fn((kind: string) => (kind === "IntegrationsLock" && lock.length > 0 ? lock : null)),
    readCompanion: vi.fn(() => null),
    apply: vi.fn(async (request: SoulWriteRequest) => {
      applied.push(request);
      const lockWrite = request.changes.find(
        (change) => change.op === "put" && change.target.kind === "IntegrationsLock"
      );
      if (lockWrite?.op === "put") lock = lockWrite.content;
      commit += 1;
      return {
        commitSha: `commit-${commit}`,
        filesChanged: request.changes.length,
        paths: [],
        pushed: true,
        published: true,
      };
    }),
  } as unknown as SoulWriter;
  const gitSync = { path: soul } as unknown as GitSyncService;
  const releaseTrust: NonNullable<IntegrationAuthoringToolContext["releaseTrust"]> = {
    authorizeInstall: vi.fn(async ({ package: candidate, approvedCommunityDigest }) => ({
      trustClass: "community" as const,
      integrationId: candidate.manifest.metadata.id,
      version: candidate.manifest.metadata.version,
      packageDigest: approvedCommunityDigest ?? "",
      hooksAllowed: false as const,
      approvedCommunityDigest: approvedCommunityDigest ?? "",
    })),
    recordInstalledProvenance: vi.fn(async ({ authorization }) => {
      provenance = {
        businessId: DEPLOYMENT_BUSINESS_ID,
        integrationId: authorization.integrationId,
        majorVersion: Number(authorization.version.split(".", 1)[0]),
        version: authorization.version,
        packageDigest: authorization.packageDigest,
        source: "integration_draft_create",
        trustClass: "community",
        approvedCommunityDigest: authorization.packageDigest,
        originalRequirements: MANIFEST,
        autoPatchOptIn: false,
        installedAt: "2026-09-07T00:00:00.000Z",
        updatedAt: "2026-09-07T00:00:00.000Z",
      };
    }),
    installedProvenance: vi.fn(async () => provenance ?? null),
  };
  return {
    context: { gitSync, soulWriter, releaseTrust },
    applied,
    root: soul,
    readLock: () => JSON.parse(lock || "{}") as Record<string, unknown>,
    releaseTrust,
  };
}

async function publish(root: string, slug: string, file: string, body: string): Promise<void> {
  await mkdir(join(root, "integrations", slug), { recursive: true });
  await writeFile(join(root, "integrations", slug, file), body, "utf8");
}

async function reviewed(context: IntegrationAuthoringToolContext, manifest = MANIFEST) {
  const result = await reviewTool.handler({ manifest }, context);
  if (!result.success) throw new Error(`review failed: ${JSON.stringify(result)}`);
  return result.data as { slug: string; packageDigest: string; installed: boolean };
}

beforeEach(() => {
  resetIntegrationDrafts();
});

describe("integration_draft_review", () => {
  it("reports the capability review and a digest without writing anything", async () => {
    const { context, applied } = await makeContext();
    const result = await reviewTool.handler({ manifest: MANIFEST }, context);
    expect(result.success).toBe(true);
    const value = result.success ? (result.data as Record<string, unknown>) : {};
    expect(value.slug).toBe("acme-status");
    expect(value.packageDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(value.installed).toBe(false);
    expect((value.review as { destinations: string[] }).destinations).toContain("status.acme.com");
    expect(applied).toHaveLength(0);
  });

  it("refuses a manifest that does not parse", async () => {
    const { context } = await makeContext();
    const result = await reviewTool.handler({ manifest: "oim: nope" }, context);
    expect(result.success).toBe(false);
  });

  it("refuses a manifest declaring JavaScript hooks", async () => {
    const { context } = await makeContext();
    const withHooks = `${HEAD}  hooks: "1.0"\n${OPERATIONS}
hooks:
  - kind: response_normalize
    file: hooks.js
    export: normalize
`;
    const result = await reviewTool.handler({ manifest: withHooks }, context);
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.message).toContain("hooks");
  });

  it("refuses companion contents whose bytes do not match the manifest digest", async () => {
    const { context } = await makeContext();
    const manifest = withFiles([{ path: "setup-guide.md", role: "guide", content: "expected" }]);
    const result = await reviewTool.handler(
      {
        manifest,
        files: [{ path: "setup-guide.md", role: "guide", content: "different" }],
      },
      context
    );
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.message).toContain(
      "setup-guide.md digest does not match"
    );
  });

  it("refuses missing and undeclared companion contents", async () => {
    const { context } = await makeContext();
    const missing = await reviewTool.handler(
      {
        manifest: withFiles([{ path: "setup-guide.md", role: "guide", content: "# Expected\n" }]),
        files: [],
      },
      context
    );
    const extra = await reviewTool.handler(
      {
        manifest: `${MANIFEST}\nfiles: []\n`,
        files: [{ path: "setup-guide.md", role: "guide", content: "# Extra\n" }],
      },
      context
    );
    expect(missing.success ? "" : missing.error.message).toContain(
      "setup-guide.md is declared but missing"
    );
    expect(extra.success ? "" : extra.error.message).toContain(
      "setup-guide.md is present but not declared"
    );
  });

  it("generates digest-covered file declarations when the draft supplies companion roles", async () => {
    const { context } = await makeContext();
    const result = await reviewTool.handler(
      {
        manifest: MANIFEST,
        files: [{ path: "setup-guide.md", role: "guide", content: "# Setup\n" }],
      },
      context
    );
    expect(result.success).toBe(true);
    const value = result.success ? (result.data as Record<string, unknown>) : {};
    expect(value.manifest).toContain(`sha256: ${oimFileDigest("# Setup\n")}`);
    expect(value.hasSetupGuide).toBe(true);
  });

  it("refuses an uncontrolled setup guide outside the package file list", async () => {
    const { context } = await makeContext();
    const result = await reviewTool.handler(
      { manifest: MANIFEST, setup_guide: "# Setup\n" },
      context
    );
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.message).toContain("digest-covered guide companion");
  });

  it("runs passing fixtures before returning a review", async () => {
    const { context } = await makeContext();
    const result = await reviewTool.handler(
      {
        manifest: withFiles([{ path: "fixtures.yml", role: "fixture", content: PASSING_FIXTURE }]),
        files: [{ path: "fixtures.yml", role: "fixture", content: PASSING_FIXTURE }],
      },
      context
    );
    expect(result.success).toBe(true);
    expect(result.success && (result.data as { fixtures: unknown }).fixtures).toEqual([
      { name: "gets-status", fixture: "fixtures.yml", passed: true },
    ]);
  });

  it("refuses a draft when one of its offline fixtures fails", async () => {
    const { context } = await makeContext();
    const failing = PASSING_FIXTURE.replace(
      "body:\n        status:\n          description: All systems operational",
      "body:\n        status:\n          description: Degraded"
    );
    const result = await reviewTool.handler(
      {
        manifest: withFiles([{ path: "fixtures.yml", role: "fixture", content: failing }]),
        files: [{ path: "fixtures.yml", role: "fixture", content: failing }],
      },
      context
    );
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.message).toContain("fixture gets-status failed");
  });

  it("tests through a host-owned Connection seam without credential arguments", async () => {
    const { context: base } = await makeContext();
    const calls: unknown[] = [];
    const test = vi.fn(async (input: unknown) => {
      calls.push(input);
      return {
        connectionId: "connection-1",
        operationId: "status",
        passed: true,
        status: "healthy",
      };
    });
    const context: IntegrationAuthoringToolContext = {
      ...base,
      connectionTester: { test },
    };
    const result = await reviewTool.handler(
      { manifest: MANIFEST, connection_id: "connection-1" },
      context
    );
    expect(result.success).toBe(true);
    expect(test).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "connection-1",
        manifest: expect.objectContaining({
          metadata: expect.objectContaining({ id: "acme-status" }),
        }),
      })
    );
    expect(Object.keys((calls[0] as Record<string, unknown>) ?? {})).not.toContain("credential");
    expect(result.success && (result.data as { connectionTest: unknown }).connectionTest).toEqual({
      connectionId: "connection-1",
      operationId: "status",
      passed: true,
      status: "healthy",
    });
  });

  it("refuses a review when the secure Connection test fails", async () => {
    const { context: base } = await makeContext();
    const context: IntegrationAuthoringToolContext = {
      ...base,
      connectionTester: {
        test: async () => ({
          connectionId: "connection-1",
          passed: false,
          error: "provider rejected the health check",
        }),
      },
    };
    const result = await reviewTool.handler(
      { manifest: MANIFEST, connection_id: "connection-1" },
      context
    );
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.message).toContain(
      "provider rejected the health check"
    );
  });
});

describe("integration_draft_create", () => {
  it("writes the exact reviewed manifest and companion bytes with the package lock", async () => {
    const { context, applied, readLock, releaseTrust } = await makeContext();
    const guide = "# Setup\n\nCreate a token.\n";
    const manifest = withFiles(
      [{ path: "setup-guide.md", role: "guide", content: guide }],
      `${MANIFEST}\n# reviewed bytes stay byte-identical\n`
    );
    const first = await reviewTool.handler(
      {
        manifest,
        files: [{ path: "setup-guide.md", role: "guide", content: guide }],
      },
      context
    );
    const digest = first.success
      ? (first.data as { packageDigest: string }).packageDigest
      : "unreviewed";
    const reviewedManifest = first.success
      ? (first.data as { manifest: string }).manifest
      : "unreviewed";
    const result = await createTool.handler(
      { slug: "acme-status", package_digest: digest },
      context
    );
    expect(result.success).toBe(true);
    expect(applied).toHaveLength(1);
    const writes = applied[0]?.changes.filter((change) => change.op === "put") ?? [];
    expect(writes).toContainEqual({
      op: "put",
      target: { kind: "Integration", slug: "acme-status", companion: "oim.yml" },
      content: reviewedManifest,
    });
    expect(writes).toContainEqual({
      op: "put",
      target: { kind: "Integration", slug: "acme-status", companion: "setup-guide.md" },
      content: guide,
    });
    expect(readLock()).toMatchObject({
      integrations: {
        "acme-status": {
          sourceType: "authored",
          manifestPath: "integrations/acme-status/oim.yml",
          definition: "oim",
          packageDigest: digest,
        },
      },
    });
    expect(releaseTrust.authorizeInstall).toHaveBeenCalledWith({
      package: {
        manifest: expect.objectContaining({
          metadata: expect.objectContaining({ id: "acme-status", version: "1.0.0" }),
        }),
        files: new Map([["setup-guide.md", guide]]),
      },
      approvedCommunityDigest: digest,
    });
    expect(releaseTrust.recordInstalledProvenance).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: DEPLOYMENT_BUSINESS_ID,
        source: "integration_draft_create",
        originalRequirements: expect.objectContaining({
          metadata: expect.objectContaining({ id: "acme-status", version: "1.0.0" }),
        }),
        autoPatchOptIn: false,
      })
    );
  });

  it("refuses to publish when durable release trust is not configured", async () => {
    const { context: configured, applied } = await makeContext();
    const { releaseTrust: _releaseTrust, ...context } = configured;
    const { packageDigest } = await reviewed(context);

    const result = await createTool.handler(
      { slug: "acme-status", package_digest: packageDigest },
      context
    );

    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.message).toContain("release trust is not configured");
    expect(applied).toHaveLength(0);
    await expect(
      createTool.handler({ slug: "acme-status", package_digest: packageDigest }, configured)
    ).resolves.toMatchObject({ success: true });
  });

  it("refuses trust authorization for bytes other than the reviewed Community package", async () => {
    const { context: base, applied } = await makeContext();
    if (base.releaseTrust === undefined) throw new Error("expected release trust");
    const context: IntegrationAuthoringToolContext = {
      ...base,
      releaseTrust: {
        ...base.releaseTrust,
        authorizeInstall: async ({ package: candidate }) => ({
          trustClass: "community",
          integrationId: candidate.manifest.metadata.id,
          version: candidate.manifest.metadata.version,
          packageDigest: "0".repeat(64),
          hooksAllowed: false,
          approvedCommunityDigest: "0".repeat(64),
        }),
      },
    };
    const { packageDigest } = await reviewed(context);

    const result = await createTool.handler(
      { slug: "acme-status", package_digest: packageDigest },
      context
    );

    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.message).toContain(
      "exact reviewed Community package"
    );
    expect(applied).toHaveLength(0);
  });

  it("CAS-rolls back publication when durable provenance cannot be recorded", async () => {
    const { context: base, applied } = await makeContext();
    if (base.releaseTrust === undefined) throw new Error("expected release trust");
    const context: IntegrationAuthoringToolContext = {
      ...base,
      releaseTrust: {
        ...base.releaseTrust,
        recordInstalledProvenance: async () => {
          throw new Error("database unavailable");
        },
      },
    };
    const { packageDigest } = await reviewed(context);

    const result = await createTool.handler(
      { slug: "acme-status", package_digest: packageDigest },
      context
    );

    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.message).toContain("publication was reverted");
    expect(applied).toHaveLength(2);
    expect(applied[1]).toMatchObject({
      subject: "soul: add integration acme-status rollback",
      expectedBaseCommit: "commit-1",
    });
    expect(applied[1]?.changes).toEqual(
      expect.arrayContaining([
        {
          op: "delete",
          target: { kind: "Integration", slug: "acme-status", companion: "oim.yml" },
        },
        { op: "delete", target: { kind: "IntegrationsLock" } },
      ])
    );
  });

  it("refuses a digest that no review produced", async () => {
    const { context, applied } = await makeContext();
    const result = await createTool.handler(
      { slug: "acme-status", package_digest: "a".repeat(64) },
      context
    );
    expect(result.success).toBe(false);
    expect(applied).toHaveLength(0);
  });

  it("spends a digest once, so one review cannot authorize two writes", async () => {
    const { context } = await makeContext();
    const { packageDigest } = await reviewed(context);
    const first = await createTool.handler(
      { slug: "acme-status", package_digest: packageDigest },
      context
    );
    const second = await createTool.handler(
      { slug: "acme-status", package_digest: packageDigest },
      context
    );
    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
  });

  it("refuses a digest reviewed for a different integration", async () => {
    const { context } = await makeContext();
    const { packageDigest } = await reviewed(context);
    const result = await createTool.handler(
      { slug: "other-thing", package_digest: packageDigest },
      context
    );
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.message).toContain("acme-status");
  });

  it("refuses to overwrite a published package unless replace is named", async () => {
    const { context, root } = await makeContext();
    await publish(root, "acme-status", "oim.yml", MANIFEST);
    const withoutReplace = await createTool.handler(
      { slug: "acme-status", package_digest: (await reviewed(context)).packageDigest },
      context
    );
    const withReplace = await createTool.handler(
      {
        slug: "acme-status",
        package_digest: (await reviewed(context)).packageDigest,
        replace: true,
      },
      context
    );
    expect(withoutReplace.success).toBe(false);
    expect(withReplace.success).toBe(true);
  });

  it("refuses a same-major replacement that breaks the published operation contract", async () => {
    const { context, root, applied } = await makeContext();
    await publish(root, "acme-status", "oim.yml", MANIFEST);
    const incompatible = MANIFEST.replace("name: acme_status", "name: acme_status_v2");
    const result = await createTool.handler(
      {
        slug: "acme-status",
        package_digest: (await reviewed(context, incompatible)).packageDigest,
        replace: true,
      },
      context
    );
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.message).toContain("changed name");
    expect(applied).toHaveLength(0);
  });

  it("refuses a replacement across major versions", async () => {
    const { context, root, applied } = await makeContext();
    await publish(root, "acme-status", "oim.yml", MANIFEST);
    const nextMajor = MANIFEST.replace("version: 1.0.0", "version: 2.0.0");
    const result = await createTool.handler(
      {
        slug: "acme-status",
        package_digest: (await reviewed(context, nextMajor)).packageDigest,
        replace: true,
      },
      context
    );
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.message).toContain("within major version 1");
    expect(applied).toHaveLength(0);
  });

  it("removes companions the replacement no longer declares", async () => {
    const { context, root, applied, readLock } = await makeContext({
      version: 1,
      integrations: {
        "other-package": {
          sourceUrl: "https://example.com/other.git",
          sourceType: "git",
          ref: "abc123",
        },
      },
    });
    await publish(root, "acme-status", "oim.yml", MANIFEST);
    await publish(root, "acme-status", "setup-guide.md", "# Old\n");
    const result = await createTool.handler(
      {
        slug: "acme-status",
        package_digest: (await reviewed(context)).packageDigest,
        replace: true,
      },
      context
    );
    expect(result.success).toBe(true);
    expect(applied[0]?.changes).toContainEqual({
      op: "delete",
      target: { kind: "Integration", slug: "acme-status", companion: "setup-guide.md" },
    });
    expect(readLock()).toMatchObject({
      integrations: {
        "other-package": {
          sourceUrl: "https://example.com/other.git",
          sourceType: "git",
          ref: "abc123",
        },
        "acme-status": {
          sourceType: "authored",
          definition: "oim",
        },
      },
    });
  });

  it("refuses to overwrite a legacy manifest, which is a migration and not an edit", async () => {
    const { context, root } = await makeContext();
    await publish(root, "acme-status", "manifest.yml", "name: acme-status\n");
    const result = await createTool.handler(
      {
        slug: "acme-status",
        package_digest: (await reviewed(context)).packageDigest,
        replace: true,
      },
      context
    );
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.message).toContain("legacy");
  });

  it("reports a rejected changeset as a validation error rather than a fault", async () => {
    const { context } = await makeContext();
    vi.mocked(context.soulWriter.apply).mockRejectedValueOnce(
      new SoulWriteError("INVALID_TARGET", "unknown target")
    );
    const result = await createTool.handler(
      { slug: "acme-status", package_digest: (await reviewed(context)).packageDigest },
      context
    );
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.code).toBe("validation_error");
  });
});

describe("integration_get and integration_list", () => {
  it("returns the published manifest with its review", async () => {
    const { context, root } = await makeContext();
    await publish(root, "acme-status", "oim.yml", MANIFEST);
    const result = await getIntegrationTool.handler({ slug: "acme-status" }, context);
    expect(result.success).toBe(true);
    const value = result.success ? (result.data as Record<string, unknown>) : {};
    expect(value.definition).toBe("oim");
    expect(value.packageDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports a legacy package as legacy rather than as missing", async () => {
    const { context, root } = await makeContext();
    await publish(root, "old-thing", "manifest.yml", "name: old-thing\n");
    const result = await getIntegrationTool.handler({ slug: "old-thing" }, context);
    expect(result.success && (result.data as { definition: string }).definition).toBe("legacy");
  });

  it("reports an unknown slug as not found", async () => {
    const { context } = await makeContext();
    const result = await getIntegrationTool.handler({ slug: "absent" }, context);
    expect(result.success ? "" : result.error.code).toBe("not_found");
  });

  it("lists both definition kinds, and an empty soul as empty", async () => {
    const { context, root } = await makeContext();
    expect(await listTool.handler({}, context)).toMatchObject({
      success: true,
      data: { integrations: [] },
    });
    await publish(root, "acme-status", "oim.yml", MANIFEST);
    await publish(root, "old-thing", "manifest.yml", "name: old-thing\n");
    const result = await listTool.handler({}, context);
    expect(result.success && result.data).toEqual({
      integrations: [
        { slug: "acme-status", definition: "oim" },
        { slug: "old-thing", definition: "legacy" },
      ],
    });
  });
});

describe("authorization declarations", () => {
  it("uses the canonical Soul integration target type", () => {
    for (const tool of [createTool, getIntegrationTool]) {
      expect(tool.targetsFor({ slug: "acme-status" }), tool.name).toEqual([
        { type: "soul.integration", id: "acme-status" },
      ]);
    }
    expect(listTool.targetsFor({})).toEqual([]);
  });

  it("keeps target derivation total for raw model output", () => {
    for (const input of [{}, { unexpected: true }, { slug: 7 }, null, []] as unknown[]) {
      for (const tool of [createTool, getIntegrationTool]) {
        expect(() => tool.targetsFor(input), tool.name).not.toThrow();
        expect(JSON.stringify(tool.targetsFor(input))).not.toMatch(/undefined|null/);
      }
    }
  });

  it("gates only the write behind the authoring action", () => {
    expect(createTool.authorization.action).toBe("soul.integration.author");
    for (const tool of [reviewTool, getIntegrationTool, listTool]) {
      expect(tool.authorization.action, tool.name).toBe("soul.integration.read");
    }
  });

  it("requires human approval for the publishing phase", () => {
    expect(reviewTool.requiresApproval).toBe(false);
    expect(createTool.requiresApproval).toBe(true);
  });
});
