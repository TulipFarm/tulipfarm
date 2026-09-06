import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function makeContext(): Promise<{
  context: IntegrationAuthoringToolContext;
  applied: SoulWriteRequest[];
  root: string;
}> {
  const soul = await mkdtemp(join(tmpdir(), "oim-authoring-"));
  const applied: SoulWriteRequest[] = [];
  const soulWriter = {
    apply: vi.fn(async (request: SoulWriteRequest) => {
      applied.push(request);
      return { sha: "abc1234", filesChanged: request.changes.length };
    }),
  } as unknown as SoulWriter;
  const gitSync = { path: soul } as unknown as GitSyncService;
  return { context: { gitSync, soulWriter }, applied, root: soul };
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

  it("refuses a manifest declaring companion files a Chat author cannot supply", async () => {
    const { context } = await makeContext();
    const withFiles = `${MANIFEST}
files:
  - path: guide.md
    role: guide
    sha256: "${"0".repeat(64)}"
`;
    const result = await reviewTool.handler({ manifest: withFiles }, context);
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.message).toContain("files");
  });
});

describe("integration_draft_create", () => {
  it("writes oim.yml and the setup guide as companions of the integration", async () => {
    const { context, applied } = await makeContext();
    const first = await reviewTool.handler(
      { manifest: MANIFEST, setup_guide: "# Setup\n\nCreate a token." },
      context
    );
    const digest = first.success
      ? (first.data as { packageDigest: string }).packageDigest
      : "unreviewed";
    const result = await createTool.handler(
      { slug: "acme-status", package_digest: digest },
      context
    );
    expect(result.success).toBe(true);
    expect(applied).toHaveLength(1);
    expect(
      applied[0]?.changes.map((change) => ("target" in change ? change.target : change))
    ).toEqual([
      { kind: "Integration", slug: "acme-status", companion: "oim.yml" },
      { kind: "Integration", slug: "acme-status", companion: "setup-guide.md" },
    ]);
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
});
