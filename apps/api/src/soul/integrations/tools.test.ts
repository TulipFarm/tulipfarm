import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { oimFileDigest, oimPackageDigest, parseOimManifest } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import type { InstalledIntegrationGeneration } from "./drafts";
import { IntegrationDraftStore } from "./drafts";
import {
  INTEGRATION_AUTHORING_TOOLS,
  type IntegrationAuthoringToolContext,
  type ReviewedCommunityIntegrationInstaller,
} from "./tools";

const SETUP_GUIDE = "# Connect Acme\n\nCreate a token, then add a Connection.\n";
const FIXTURES = `version: 1
cases:
  - name: gets-status
    operationId: status
    request: {}
    response:
      status: 200
      body:
        status: operational
    expect:
      request:
        method: GET
        url: https://status.acme.example/v1/status
      result:
        status: operational
`;
const MANIFEST = `oimVersion: "1.0"
kind: Integration
metadata:
  id: acme-status
  name: Acme Status
  version: 1.0.0
  description: Read Acme service status.
  license: MIT
profiles:
  core: "1.0"
files:
  - path: setup-guide.md
    role: guide
    sha256: "${oimFileDigest(SETUP_GUIDE)}"
  - path: fixtures.yml
    role: fixture
    sha256: "${oimFileDigest(FIXTURES)}"
operations:
  - id: status
    name: acme_status
    description: Read Acme service status.
    effect: read
    identityMode: shared_only
    source:
      type: http
      method: GET
      baseUrl: https://status.acme.example
      path: /v1/status
    response:
      maxBytes: 65536
      schema:
        type: object
        properties:
          status: { type: string }
      projection:
        - /status
`;

function tool(name: string) {
  const found = INTEGRATION_AUTHORING_TOOLS.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`missing Tool ${name}`);
  return found;
}

function generation(installationId: string): InstalledIntegrationGeneration {
  const manifest = parseOimManifest(MANIFEST);
  return {
    businessId: "business-1",
    integrationId: "acme-status",
    majorVersion: 1,
    installationId,
    version: manifest.metadata.version,
    packageDigest: oimPackageDigest(manifest),
    source: {
      kind: "authored_draft",
      reviewId: "review-previous",
      reviewedAt: "2026-09-12T00:00:00.000Z",
      reviewedBy: {
        businessId: "business-1",
        principal: { kind: "user", id: "user-1" },
      },
      runId: "run-previous",
    },
    slug: "acme-status",
    soulRevision: `soul-${installationId}`,
    trustClass: "community",
    approvedCommunityDigest: oimPackageDigest(manifest),
    originalRequirements: {},
    autoPatchOptIn: false,
    installedAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  };
}

function context(
  options: {
    readonly installer?: ReviewedCommunityIntegrationInstaller;
    readonly integrations?: ReturnType<IntegrationAuthoringToolContext["integrations"]>;
    readonly drafts?: IntegrationDraftStore;
    readonly installedGenerations?: IntegrationAuthoringToolContext["installedGenerations"];
    readonly requestContext?: IntegrationAuthoringToolContext["requestContext"];
  } = {}
): IntegrationAuthoringToolContext {
  return {
    businessId: "business-1",
    integrations: () => options.integrations ?? new Map(),
    installedGenerations: options.installedGenerations ?? {
      findInstalledGeneration: async () => null,
    },
    drafts:
      options.drafts ??
      new IntegrationDraftStore({
        now: () => Date.parse("2026-09-13T00:00:00.000Z"),
        reviewId: () => "review-1",
      }),
    ...(options.installer === undefined ? {} : { installer: options.installer }),
    requestContext:
      options.requestContext ??
      ({
        userId: "user-1",
        subject: { kind: "user", id: "user-1" },
        actor: {
          principalId: "user:user-1",
          name: "Muskan Vijayvargiya",
          email: "muskan@example.test",
        },
        runId: "run-1",
        toolCallId: "call-1",
      } satisfies IntegrationAuthoringToolContext["requestContext"]),
  };
}

function manifestWithout(role: "guide" | "fixture"): string {
  const document = parse(MANIFEST) as {
    files: { path: string; role: string; sha256: string }[];
  };
  document.files = document.files.filter((file) => file.role !== role);
  return stringify(document);
}

function manifestWithUncoveredOperation(): string {
  const document = parse(MANIFEST) as {
    operations: Record<string, unknown>[];
  };
  document.operations.push({
    ...document.operations[0],
    id: "summary",
    name: "acme_summary",
    description: "Read the Acme status summary.",
  });
  return stringify(document);
}

describe("Integration authoring Tool gates", () => {
  it("keeps reads approval-free and requires approval for creation", () => {
    expect(tool("integration_draft_review")).toMatchObject({
      mutating: false,
      requiresApproval: false,
      authorization: { action: "soul.integration.read" },
    });
    expect(tool("integration_get")).toMatchObject({
      mutating: false,
      requiresApproval: false,
      authorization: { action: "soul.integration.read" },
    });
    expect(tool("integration_list")).toMatchObject({
      mutating: false,
      requiresApproval: false,
      authorization: { action: "soul.integration.read" },
    });
    expect(tool("integration_draft_create")).toMatchObject({
      mutating: true,
      requiresApproval: true,
      authorization: { action: "soul.integration.author" },
    });
  });
});

describe("integration_draft_review", () => {
  it("reviews exact package bytes without installing them", async () => {
    const install = vi.fn<ReviewedCommunityIntegrationInstaller["install"]>();
    const result = await tool("integration_draft_review").handler(
      {
        manifest: MANIFEST,
        files: [
          { path: "setup-guide.md", role: "guide", content: SETUP_GUIDE },
          { path: "fixtures.yml", role: "fixture", content: FIXTURES },
        ],
      },
      context({ installer: { install } })
    );

    expect(result.success).toBe(true);
    expect(install).not.toHaveBeenCalled();
    if (!result.success) return;
    expect(result.data).toMatchObject({
      slug: "acme-status",
      reviewId: "review-1",
      reviewedAt: "2026-09-13T00:00:00.000Z",
      installed: false,
      hasSetupGuide: true,
      fixtures: [{ name: "gets-status", fixture: "fixtures.yml", passed: true }],
      review: {
        destinations: ["status.acme.example"],
        operations: [{ name: "acme_status", effect: "read" }],
      },
    });
    expect(result.data).toHaveProperty("packageDigest");
  });

  it("does not fake an optional Connection test", async () => {
    const result = await tool("integration_draft_review").handler(
      {
        manifest: MANIFEST,
        files: [
          { path: "setup-guide.md", role: "guide", content: SETUP_GUIDE },
          { path: "fixtures.yml", role: "fixture", content: FIXTURES },
        ],
        connection_id: "connection-1",
      },
      context()
    );

    expect(result).toEqual({
      success: false,
      error: {
        code: "unavailable",
        message: "Draft Connection testing is not configured on this deployment.",
      },
    });
  });

  it("requires a server-resolved Run before issuing a draft", async () => {
    const { runId: _runId, ...requestContext } = context().requestContext;
    const result = await tool("integration_draft_review").handler(
      {
        manifest: MANIFEST,
        files: [
          { path: "setup-guide.md", role: "guide", content: SETUP_GUIDE },
          { path: "fixtures.yml", role: "fixture", content: FIXTURES },
        ],
      },
      context({ requestContext })
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: "internal_error", message: expect.stringContaining("Run identity") },
    });
  });

  it.each([
    {
      name: "a declared setup guide",
      manifest: manifestWithout("guide"),
      files: [{ path: "fixtures.yml", role: "fixture", content: FIXTURES }],
      message: "setup-guide.md",
    },
    {
      name: "offline fixture coverage",
      manifest: manifestWithout("fixture"),
      files: [{ path: "setup-guide.md", role: "guide", content: SETUP_GUIDE }],
      message: "operation status has no offline fixture",
    },
    {
      name: "coverage for every operation",
      manifest: manifestWithUncoveredOperation(),
      files: [
        { path: "setup-guide.md", role: "guide", content: SETUP_GUIDE },
        { path: "fixtures.yml", role: "fixture", content: FIXTURES },
      ],
      message: "operation summary has no offline fixture",
    },
  ])("refuses a draft without $name", async ({ manifest, files, message }) => {
    const result = await tool("integration_draft_review").handler({ manifest, files }, context());

    expect(result).toMatchObject({
      success: false,
      error: { code: "validation_error", message: expect.stringContaining(message) },
    });
  });

  it.each([
    "integration-forge-reviews-before-publishing.json",
    "integration-publish-without-review-is-refused.json",
  ])("grounds %s through the production review handler", async (filename) => {
    const corpusPath = join(process.cwd(), "../eval/corpus", filename);
    const evalCase = JSON.parse(await readFile(corpusPath, "utf8")) as {
      readonly script: readonly {
        readonly kind: string;
        readonly calls?: readonly {
          readonly name: string;
          readonly arguments: unknown;
        }[];
      }[];
      readonly toolResults: readonly {
        readonly name: string;
        readonly output?: unknown;
      }[];
    };
    const call = evalCase.script
      .flatMap((step) => step.calls ?? [])
      .find((candidate) => candidate.name === "integration_draft_review");
    const expected = evalCase.toolResults.find(
      (result) => result.name === "integration_draft_review"
    )?.output;
    if (call === undefined || typeof expected !== "object" || expected === null) {
      throw new Error(`${filename} has no grounded Integration review`);
    }

    const result = await tool("integration_draft_review").handler(call.arguments, context());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject(expected);
  });
});

describe("integration_draft_create", () => {
  it("installs only the exact reviewed package once", async () => {
    const drafts = new IntegrationDraftStore({
      now: () => Date.parse("2026-09-13T00:00:00.000Z"),
      reviewId: () => "review-1",
    });
    const install = vi.fn<ReviewedCommunityIntegrationInstaller["install"]>(async (input) => {
      const draft = await drafts.claim({
        businessId: input.businessId,
        approvedPackageDigest: input.packageDigest,
        principal: input.principal,
        runId: input.runId,
      });
      if (draft === null) {
        return {
          success: false,
          error: { code: "validation_error", message: "review unavailable" },
        };
      }
      await drafts.acknowledge({
        businessId: input.businessId,
        approvedPackageDigest: input.packageDigest,
        principal: input.principal,
        runId: input.runId,
        reviewId: draft.source.reviewId,
        operationId: "operation-1",
      });
      return {
        success: true,
        data: {
          slug: "acme-status",
          installed: true,
        },
      };
    });
    const toolContext = context({ installer: { install }, drafts });
    const reviewed = await tool("integration_draft_review").handler(
      {
        manifest: MANIFEST,
        files: [
          { path: "setup-guide.md", role: "guide", content: SETUP_GUIDE },
          { path: "fixtures.yml", role: "fixture", content: FIXTURES },
        ],
      },
      toolContext
    );
    expect(reviewed.success).toBe(true);
    if (!reviewed.success) return;
    const { packageDigest } = reviewed.data as { packageDigest: string };

    const created = await tool("integration_draft_create").handler(
      {
        slug: "acme-status",
        package_digest: packageDigest,
      },
      toolContext
    );

    expect(created).toEqual({
      success: true,
      data: { slug: "acme-status", installed: true },
    });
    expect(install).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith({
      businessId: "business-1",
      slug: "acme-status",
      packageDigest,
      principal: { kind: "user", id: "user-1" },
      runId: "run-1",
      replace: false,
    });

    const replay = await tool("integration_draft_create").handler(
      {
        slug: "acme-status",
        package_digest: packageDigest,
      },
      toolContext
    );
    expect(replay).toMatchObject({
      success: false,
      error: { code: "validation_error" },
    });
    expect(install).toHaveBeenCalledOnce();
  });

  it("refuses an unreviewed digest before invoking the installer", async () => {
    const install = vi.fn<ReviewedCommunityIntegrationInstaller["install"]>();
    const result = await tool("integration_draft_create").handler(
      {
        slug: "acme-status",
        package_digest: "f".repeat(64),
      },
      context({ installer: { install } })
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: "validation_error" },
    });
    expect(install).not.toHaveBeenCalled();
  });

  it("does not let another Run spend a reviewed draft", async () => {
    const drafts = new IntegrationDraftStore({
      now: () => Date.parse("2026-09-13T00:00:00.000Z"),
      reviewId: () => "review-1",
    });
    const install = vi.fn<ReviewedCommunityIntegrationInstaller["install"]>();
    const reviewingContext = context({ drafts, installer: { install } });
    const reviewed = await tool("integration_draft_review").handler(
      {
        manifest: MANIFEST,
        files: [
          { path: "setup-guide.md", role: "guide", content: SETUP_GUIDE },
          { path: "fixtures.yml", role: "fixture", content: FIXTURES },
        ],
      },
      reviewingContext
    );
    expect(reviewed.success).toBe(true);
    if (!reviewed.success) return;
    const { packageDigest } = reviewed.data as { packageDigest: string };

    const otherRun = context({
      drafts,
      installer: { install },
      requestContext: { ...reviewingContext.requestContext, runId: "run-2" },
    });
    const result = await tool("integration_draft_create").handler(
      { slug: "acme-status", package_digest: packageDigest },
      otherRun
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: "validation_error" },
    });
    expect(install).not.toHaveBeenCalled();
  });

  it("requires a server-resolved Run before consuming a draft", async () => {
    const drafts = new IntegrationDraftStore({
      now: () => Date.parse("2026-09-13T00:00:00.000Z"),
      reviewId: () => "review-1",
    });
    const install = vi.fn<ReviewedCommunityIntegrationInstaller["install"]>();
    const reviewingContext = context({ drafts, installer: { install } });
    const reviewed = await tool("integration_draft_review").handler(
      {
        manifest: MANIFEST,
        files: [
          { path: "setup-guide.md", role: "guide", content: SETUP_GUIDE },
          { path: "fixtures.yml", role: "fixture", content: FIXTURES },
        ],
      },
      reviewingContext
    );
    expect(reviewed.success).toBe(true);
    if (!reviewed.success) return;
    const { packageDigest } = reviewed.data as { packageDigest: string };
    const { runId: _runId, ...withoutRun } = reviewingContext.requestContext;

    const result = await tool("integration_draft_create").handler(
      { slug: "acme-status", package_digest: packageDigest },
      context({ drafts, installer: { install }, requestContext: withoutRun })
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: "internal_error", message: expect.stringContaining("invocation identity") },
    });
    expect(install).not.toHaveBeenCalled();
  });

  it("pins the reviewed replacement generation across approval", async () => {
    const generationA = generation("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const generationB = generation("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    let currentGeneration = generationA;
    const installedGenerations = {
      findInstalledGeneration: async () => currentGeneration,
    };
    const integrations = new Map([
      [
        "acme-status",
        {
          slug: "acme-status",
          sourceIntegration: "acme-status",
          oimManifest: parseOimManifest(MANIFEST),
        },
      ],
    ]);
    const drafts = new IntegrationDraftStore({
      now: () => Date.parse("2026-09-13T00:00:00.000Z"),
      reviewId: (() => {
        let value = 0;
        return () => `review-${++value}`;
      })(),
    });
    const install = vi.fn<ReviewedCommunityIntegrationInstaller["install"]>(async (input) => {
      const claimed = await drafts.claim({
        businessId: input.businessId,
        approvedPackageDigest: input.packageDigest,
        principal: input.principal,
        runId: input.runId,
      });
      return input.replace && claimed?.replace?.installationId === currentGeneration.installationId
        ? { success: true, data: { installationId: currentGeneration.installationId } }
        : {
            success: false,
            error: {
              code: "validation_error",
              message: "The installed Integration changed. Review it again.",
            },
          };
    });
    const toolContext = context({
      drafts,
      installer: { install },
      installedGenerations,
      integrations,
    });
    const reviewArgs = {
      manifest: MANIFEST,
      files: [
        { path: "setup-guide.md", role: "guide", content: SETUP_GUIDE },
        { path: "fixtures.yml", role: "fixture", content: FIXTURES },
      ],
    };
    const firstReview = await tool("integration_draft_review").handler(reviewArgs, toolContext);
    expect(firstReview).toMatchObject({
      success: true,
      data: {
        reviewId: "review-1",
        replacement: { installationId: generationA.installationId },
      },
    });
    if (!firstReview.success) return;
    const { packageDigest } = firstReview.data as { packageDigest: string };

    currentGeneration = generationB;
    const repeatedReview = await tool("integration_draft_review").handler(reviewArgs, toolContext);
    expect(repeatedReview).toMatchObject({
      success: true,
      data: {
        reviewId: "review-1",
        replacement: { installationId: generationA.installationId },
      },
    });

    const staleAttempt = await tool("integration_draft_create").handler(
      { slug: "acme-status", package_digest: packageDigest, replace: true },
      toolContext
    );
    expect(staleAttempt).toMatchObject({
      success: false,
      error: { code: "validation_error" },
    });
    expect(install).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replace: true,
      })
    );

    const nextRunContext = context({
      drafts,
      installer: { install },
      installedGenerations,
      integrations,
      requestContext: {
        ...toolContext.requestContext,
        runId: "run-2",
        toolCallId: "call-2",
      },
    });
    const freshReview = await tool("integration_draft_review").handler(reviewArgs, nextRunContext);
    expect(freshReview).toMatchObject({
      success: true,
      data: {
        reviewId: "review-2",
        replacement: { installationId: generationB.installationId },
      },
    });
    const installed = await tool("integration_draft_create").handler(
      { slug: "acme-status", package_digest: packageDigest, replace: true },
      nextRunContext
    );
    expect(installed).toEqual({
      success: true,
      data: { installationId: generationB.installationId },
    });
    expect(install).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replace: true,
      })
    );
  });
});

describe("Integration reads", () => {
  it("reads only the active Integration map", async () => {
    const integrations: ReturnType<IntegrationAuthoringToolContext["integrations"]> = new Map([
      [
        "acme-status",
        {
          slug: "acme-status",
          sourceIntegration: "acme-status",
          oimManifest: {
            oimVersion: "1.0",
            kind: "Integration",
            metadata: {
              id: "acme-status",
              name: "Acme Status",
              version: "1.0.0",
              description: "Read Acme service status.",
              license: "MIT",
            },
            profiles: { core: "1.0" },
            operations: [],
          },
          setupGuide: SETUP_GUIDE,
        },
      ],
    ]);
    const toolContext = context({ integrations });

    const listed = await tool("integration_list").handler({}, toolContext);
    const found = await tool("integration_get").handler({ slug: "acme-status" }, toolContext);

    expect(listed).toEqual({
      success: true,
      data: [{ slug: "acme-status", kind: "oim", title: "Acme Status" }],
    });
    expect(found).toMatchObject({
      success: true,
      data: {
        slug: "acme-status",
        oimManifest: {
          metadata: { id: "acme-status" },
        },
        setupGuide: SETUP_GUIDE,
      },
    });
  });
});
