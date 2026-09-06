import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { describeOimCapabilities } from "@tulipfarm/integrations";
import {
  INTEGRATION_DRAFT_CREATE_TOOL_DECLARATION,
  INTEGRATION_DRAFT_REVIEW_TOOL_DECLARATION,
  INTEGRATION_GET_TOOL_DECLARATION,
  INTEGRATION_LIST_TOOL_DECLARATION,
  type OimManifest,
  oimPackageDigest,
  parseOimManifest,
} from "@tulipfarm/schema";
import {
  type GitSyncService,
  type SoulWrite,
  SoulWriteError,
  type SoulWriter,
} from "@tulipfarm/soul";
import {
  type ApiToolDefinition,
  defineApiTool,
  err,
  ok,
  type RequestContext,
  type ToolCallResult,
} from "@tulipfarm/tool-host";
import { stringify } from "yaml";
import { SYSTEM_SOUL_COMMIT_ACTOR } from "../../runtime/soul-writer";
import { soulCommitError } from "../../tools/soul-faults";
import { putIntegrationDraft, takeIntegrationDraft } from "./drafts";

export interface IntegrationAuthoringToolContext {
  readonly gitSync: GitSyncService;
  readonly soulWriter: SoulWriter;
  readonly requestContext?: RequestContext;
}

const SOUL_INTEGRATION_TARGET = "soul.integration";

function root(context: IntegrationAuthoringToolContext): string {
  return join(context.gitSync.path, "integrations");
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringArg(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integrationTargets(args: unknown) {
  const id = stringArg(args, "slug");
  // Soul targets use the same two-level name as their static resource (`soul.<thing>`).
  return id === undefined ? [] : [{ type: SOUL_INTEGRATION_TARGET, id }];
}

/**
 * Everything this authoring path refuses to draft, stated as its own answer rather than left to
 * the installer to discover.
 *
 * `hooks` asks for JavaScript to run inside TulipFarm, which no unsigned package may do. `files`
 * declares content-addressed companions, and a Chat author has no way to hand over those bytes —
 * accepting the declaration would write a package the loader then rejects as incomplete.
 */
function draftRefusals(manifest: OimManifest): string[] {
  const refusals: string[] = [];
  if ((manifest.hooks ?? []).length > 0) {
    refusals.push("hooks: an authored package may not declare JavaScript hooks");
  }
  if ((manifest.files ?? []).length > 0) {
    refusals.push(
      "files: companion files cannot be authored from Chat; install the package from a git source instead"
    );
  }
  return refusals;
}

/**
 * Map a Soul write-gateway rejection onto this tool family's error vocabulary.
 *
 * A rejected changeset is a `validation_error`, a moved base is transient (`unavailable`), and a
 * failed commit is classified by `soulCommitError` so git contention is reported as `unavailable`
 * rather than as a request the model should repair.
 */
function mapIntegrationWriteError(error: SoulWriteError): ToolCallResult {
  switch (error.code) {
    case "PRECONDITION_FAILED":
    case "VALIDATION_FAILED":
    case "INVALID_TARGET":
      return err("validation_error", error.message);
    case "CONFLICT":
      return err("unavailable", error.message);
    default:
      return soulCommitError(error, error.message);
  }
}

async function packageDirectories(
  context: IntegrationAuthoringToolContext
): Promise<{ slug: string; definition: "oim" | "legacy" }[]> {
  let entries: string[];
  try {
    entries = (await readdir(root(context), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const found: { slug: string; definition: "oim" | "legacy" }[] = [];
  for (const slug of entries.sort()) {
    const files = await readdir(join(root(context), slug)).catch(() => [] as string[]);
    if (files.includes("oim.yml")) found.push({ slug, definition: "oim" });
    else if (files.includes("manifest.yml")) found.push({ slug, definition: "legacy" });
  }
  return found;
}

const review = defineApiTool<IntegrationAuthoringToolContext>({
  ...INTEGRATION_DRAFT_REVIEW_TOOL_DECLARATION,
  tier: "system",
  authorization: {
    action: "soul.integration.read",
    resources: ["soul.integration"],
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, context) => {
    const { manifest: source, setup_guide: setupGuide } = args as {
      manifest: string;
      setup_guide?: string;
    };
    let manifest: OimManifest;
    try {
      manifest = parseOimManifest(source);
    } catch (error) {
      return err("validation_error", reason(error));
    }
    const refusals = draftRefusals(manifest);
    if (refusals.length > 0) return err("validation_error", refusals.join("; "));

    const slug = manifest.metadata.id;
    const digest = oimPackageDigest(manifest);
    // Normalized, not the author's bytes: this is what the review was computed over and what the
    // write must therefore land, so the digest describes the installed package exactly.
    putIntegrationDraft(digest, {
      slug,
      manifestYaml: stringify(manifest),
      ...(setupGuide === undefined ? {} : { setupGuide }),
    });
    const existing = await packageDirectories(context);
    return ok({
      slug,
      packageDigest: digest,
      installed: existing.some((entry) => entry.slug === slug),
      hasSetupGuide: setupGuide !== undefined,
      review: describeOimCapabilities(manifest),
    });
  },
});

const create = defineApiTool<IntegrationAuthoringToolContext>({
  ...INTEGRATION_DRAFT_CREATE_TOOL_DECLARATION,
  tier: "system",
  authorization: {
    action: "soul.integration.author",
    resources: ["soul.integration"],
    targets: integrationTargets,
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, context) => {
    const {
      slug,
      package_digest: digest,
      replace,
    } = args as { slug: string; package_digest: string; replace?: boolean };
    const draft = takeIntegrationDraft(digest);
    if (draft === undefined) {
      return err(
        "validation_error",
        "No reviewed package carries that digest. Call integration_draft_review first, then pass the digest it reports."
      );
    }
    if (draft.slug !== slug) {
      return err("validation_error", `That digest belongs to integration ${draft.slug}.`);
    }
    const existing = await packageDirectories(context);
    const published = existing.find((entry) => entry.slug === slug);
    if (published !== undefined && replace !== true) {
      return err(
        "validation_error",
        `Integration ${slug} is already published. Pass replace to overwrite it.`
      );
    }
    if (published?.definition === "legacy") {
      return err(
        "validation_error",
        `Integration ${slug} is published as a legacy manifest. Migrating it is a separate change, not an overwrite.`
      );
    }

    // `oim.yml` is addressed as a companion because the layout registry knows exactly one
    // superseded definition file for an Integration; see packageChanges() in integrations/install.ts.
    const changes: SoulWrite[] = [
      {
        op: "put",
        target: { kind: "Integration", slug, companion: "oim.yml" },
        content: draft.manifestYaml,
      },
    ];
    if (draft.setupGuide !== undefined) {
      changes.push({
        op: "put",
        target: { kind: "Integration", slug, companion: "setup-guide.md" },
        content: draft.setupGuide,
      });
    }
    try {
      await context.soulWriter.apply({
        subject: `soul: ${published === undefined ? "add" : "update"} integration ${slug}`,
        source: "agent",
        actor: context.requestContext?.actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
        businessId: DEPLOYMENT_BUSINESS_ID,
        changes,
      });
      return ok({ slug, packageDigest: digest, replaced: published !== undefined });
    } catch (error) {
      if (error instanceof SoulWriteError) return mapIntegrationWriteError(error);
      return soulCommitError(error, reason(error));
    }
  },
});

const get = defineApiTool<IntegrationAuthoringToolContext>({
  ...INTEGRATION_GET_TOOL_DECLARATION,
  tier: "system",
  authorization: {
    action: "soul.integration.read",
    resources: ["soul.integration"],
    targets: integrationTargets,
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, context) => {
    const { slug } = args as { slug: string };
    const directory = join(root(context), slug);
    let source: string;
    try {
      source = await readFile(join(directory, "oim.yml"), "utf8");
    } catch {
      const legacy = await readFile(join(directory, "manifest.yml"), "utf8").catch(() => undefined);
      if (legacy === undefined) return err("not_found", "Integration was not found.");
      return ok({ slug, definition: "legacy" });
    }
    let manifest: OimManifest;
    try {
      manifest = parseOimManifest(source);
    } catch (error) {
      return err("validation_error", `Published manifest is invalid: ${reason(error)}`);
    }
    const setupGuide = await readFile(join(directory, "setup-guide.md"), "utf8").catch(
      () => undefined
    );
    return ok({
      slug,
      definition: "oim",
      manifest: source,
      packageDigest: oimPackageDigest(manifest),
      review: describeOimCapabilities(manifest),
      ...(setupGuide === undefined ? {} : { setupGuide }),
    });
  },
});

const list = defineApiTool<IntegrationAuthoringToolContext>({
  ...INTEGRATION_LIST_TOOL_DECLARATION,
  tier: "system",
  authorization: {
    action: "soul.integration.read",
    resources: ["soul.integration"],
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (_args, context) => ok({ integrations: await packageDirectories(context) }),
});

export const INTEGRATION_AUTHORING_TOOLS: readonly ApiToolDefinition<IntegrationAuthoringToolContext>[] =
  [review, create, get, list];
