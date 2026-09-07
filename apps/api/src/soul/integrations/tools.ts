import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { describeOimCapabilities, runOimFixtures } from "@tulipfarm/integrations";
import {
  INTEGRATION_DRAFT_CREATE_TOOL_DECLARATION,
  INTEGRATION_DRAFT_REVIEW_TOOL_DECLARATION,
  INTEGRATION_GET_TOOL_DECLARATION,
  INTEGRATION_LIST_TOOL_DECLARATION,
  type OimCompanionFile,
  type OimManifest,
  oimCompatibilityIssues,
  oimFileDigest,
  oimPackageDigest,
  oimPackageIssues,
  parseOimManifest,
} from "@tulipfarm/schema";
import {
  artifactWriteTarget,
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
import { parse, stringify } from "yaml";
import {
  type OimInstallTrust,
  readIntegrationLock,
  serializeIntegrationLock,
} from "../../integrations/install";
import { SYSTEM_SOUL_COMMIT_ACTOR } from "../../runtime/soul-writer";
import { soulCommitError } from "../../tools/soul-faults";
import { putIntegrationDraft, takeIntegrationDraft } from "./drafts";

interface DraftFileInput {
  readonly path: string;
  readonly role: OimCompanionFile["role"];
  readonly content: string;
}

export interface IntegrationDraftConnectionTestResult {
  readonly connectionId: string;
  readonly passed: boolean;
  readonly operationId?: string;
  readonly status?: string;
  readonly error?: string;
}

export interface IntegrationAuthoringToolContext {
  readonly gitSync: GitSyncService;
  readonly soulWriter: SoulWriter;
  readonly releaseTrust?: OimInstallTrust;
  readonly requestContext?: RequestContext;
  /**
   * Optional host-owned credential seam. The Tool supplies only a Connection id and validated
   * package; the implementation resolves authorization and Secret leases outside model arguments.
   */
  readonly connectionTester?: {
    test(input: {
      readonly manifest: OimManifest;
      readonly companions: ReadonlyMap<string, string>;
      readonly connectionId: string;
      readonly requestContext?: RequestContext;
    }): Promise<IntegrationDraftConnectionTestResult>;
  };
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

function draftRefusals(manifest: OimManifest): string[] {
  const refusals: string[] = [];
  if (
    (manifest.hooks ?? []).length > 0 ||
    (manifest.files ?? []).some((file) => file.role === "hook")
  ) {
    refusals.push("hooks: an authored package may not declare JavaScript hooks");
  }
  return refusals;
}

function draftFiles(args: unknown): DraftFileInput[] {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return [];
  const files = (args as { files?: unknown }).files;
  return Array.isArray(files) ? (files as DraftFileInput[]) : [];
}

function prepareDraftPackage(
  source: string,
  files: readonly DraftFileInput[]
): {
  manifest: OimManifest;
  manifestYaml: string;
  companions: ReadonlyMap<string, string>;
} {
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) throw new Error(`files: ${file.path} was supplied more than once`);
    paths.add(file.path);
  }

  let manifestYaml = source;
  let document: unknown;
  try {
    document = parse(source);
  } catch (error) {
    throw new Error(`cannot parse OIM manifest YAML: ${reason(error)}`);
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("OIM manifest must be an object");
  }

  const candidate = document as Record<string, unknown>;
  if (candidate.files === undefined && files.length > 0) {
    candidate.files = files.map(({ path, role, content }) => ({
      path,
      role,
      sha256: oimFileDigest(content),
    }));
    manifestYaml = stringify(candidate);
  }

  const manifest = parseOimManifest(manifestYaml);
  manifestYaml = stringify(manifest);
  const declared = new Map((manifest.files ?? []).map((file) => [file.path, file]));
  for (const file of files) {
    const declaration = declared.get(file.path);
    if (declaration !== undefined && declaration.role !== file.role) {
      throw new Error(
        `files: ${file.path} was supplied with role ${file.role}, but the manifest declares ${declaration.role}`
      );
    }
  }
  const companions = new Map(files.map((file) => [file.path, file.content]));
  const issues = [...draftRefusals(manifest), ...oimPackageIssues(manifest, companions)];
  if (issues.length > 0) throw new Error(issues.join("; "));
  return { manifest, manifestYaml, companions };
}

async function packageFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await packageFiles(join(directory, entry.name), path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort();
}

async function publishedManifest(
  context: IntegrationAuthoringToolContext,
  slug: string
): Promise<OimManifest | undefined> {
  const source = await readFile(join(root(context), slug, "oim.yml"), "utf8").catch(
    () => undefined
  );
  return source === undefined ? undefined : parseOimManifest(source);
}

async function compatibilityIssues(
  context: IntegrationAuthoringToolContext,
  manifest: OimManifest
): Promise<string[]> {
  try {
    const current = await publishedManifest(context, manifest.metadata.id);
    return current === undefined ? [] : oimCompatibilityIssues(current, manifest);
  } catch (error) {
    return [`published oim.yml is invalid: ${reason(error)}`];
  }
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

function inversePublication(soulWriter: SoulWriter, changes: readonly SoulWrite[]): SoulWrite[] {
  return changes.flatMap((change): SoulWrite[] => {
    if (change.op === "deleteArtifact") {
      throw new Error("cannot safely roll back an artifact deletion");
    }
    const previous =
      change.target.companion === undefined
        ? soulWriter.read(change.target.kind, change.target.slug)
        : soulWriter.readCompanion(
            change.target.kind,
            change.target.slug ?? "",
            change.target.companion
          );
    if (previous === null) {
      return change.op === "delete" ? [] : [{ op: "delete", target: change.target }];
    }
    return [{ op: "put", target: change.target, content: previous }];
  });
}

function majorVersion(manifest: OimManifest): number {
  return Number(manifest.metadata.version.split(".", 1)[0]);
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
    const { manifest: source, connection_id: connectionId } = args as {
      manifest: string;
      connection_id?: string;
    };
    if (
      args !== null &&
      typeof args === "object" &&
      !Array.isArray(args) &&
      Object.hasOwn(args, "setup_guide")
    ) {
      return err(
        "validation_error",
        "setup_guide is not an independent file; supply setup-guide.md as a digest-covered guide companion"
      );
    }
    let prepared: ReturnType<typeof prepareDraftPackage>;
    try {
      prepared = prepareDraftPackage(source, draftFiles(args));
    } catch (error) {
      return err("validation_error", reason(error));
    }
    const { manifest, manifestYaml, companions } = prepared;
    const fixtureResults = await runOimFixtures(manifest, companions);
    const fixtureFailures = fixtureResults.filter((fixture) => !fixture.passed);
    if (fixtureFailures.length > 0) {
      return err(
        "validation_error",
        fixtureFailures
          .map((fixture) => `fixture ${fixture.name} failed: ${fixture.error}`)
          .join("; ")
      );
    }

    let connectionTest: IntegrationDraftConnectionTestResult | undefined;
    if (connectionId !== undefined) {
      if (context.connectionTester === undefined) {
        return err("unavailable", "Draft Connection testing is not configured on this deployment.");
      }
      try {
        connectionTest = await context.connectionTester.test({
          manifest,
          companions,
          connectionId,
          ...(context.requestContext === undefined
            ? {}
            : { requestContext: context.requestContext }),
        });
      } catch (error) {
        return err("validation_error", `Connection test failed: ${reason(error)}`);
      }
      if (!connectionTest.passed) {
        return err(
          "validation_error",
          `Connection test failed${connectionTest.error ? `: ${connectionTest.error}` : ""}`
        );
      }
    }

    const slug = manifest.metadata.id;
    const digest = oimPackageDigest(manifest);
    const files = (manifest.files ?? []).map((file) => ({
      path: file.path,
      role: file.role,
      content: companions.get(file.path) as string,
    }));
    putIntegrationDraft(digest, {
      slug,
      manifest,
      manifestYaml,
      files,
    });
    const existing = await packageDirectories(context);
    const replacementIssues = await compatibilityIssues(context, manifest);
    return ok({
      slug,
      packageDigest: digest,
      manifest: manifestYaml,
      installed: existing.some((entry) => entry.slug === slug),
      hasSetupGuide: files.some((file) => file.role === "guide" && file.path === "setup-guide.md"),
      fixtures: fixtureResults,
      ...(connectionTest === undefined ? {} : { connectionTest }),
      ...(replacementIssues.length === 0 ? {} : { replacementIssues }),
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
  requiresApproval: true,
  handler: async (args, context) => {
    const {
      slug,
      package_digest: digest,
      replace,
    } = args as { slug: string; package_digest: string; replace?: boolean };
    if (context.releaseTrust === undefined) {
      return err(
        "unavailable",
        "OIM release trust is not configured; the reviewed package was not published."
      );
    }
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
    if (published !== undefined) {
      const issues = await compatibilityIssues(context, draft.manifest);
      if (issues.length > 0) {
        return err(
          "validation_error",
          `Incompatible replacement for integration ${slug}: ${issues.join("; ")}`
        );
      }
    }
    const companions = new Map(draft.files.map((file) => [file.path, file.content]));
    let authorization: Awaited<ReturnType<OimInstallTrust["authorizeInstall"]>>;
    try {
      authorization = await context.releaseTrust.authorizeInstall({
        package: { manifest: draft.manifest, files: companions },
        approvedCommunityDigest: digest,
      });
      if (
        authorization.trustClass !== "community" ||
        authorization.integrationId !== slug ||
        authorization.version !== draft.manifest.metadata.version ||
        authorization.packageDigest !== digest ||
        authorization.approvedCommunityDigest !== digest
      ) {
        return err(
          "validation_error",
          "Release trust did not authorize the exact reviewed Community package."
        );
      }
    } catch (error) {
      return err(
        "validation_error",
        `Release trust refused the reviewed package: ${reason(error)}`
      );
    }

    const changes: SoulWrite[] = [
      {
        op: "put",
        target: { kind: "Integration", slug, companion: "oim.yml" },
        content: draft.manifestYaml,
      },
    ];
    for (const file of draft.files) {
      changes.push({
        op: "put",
        target: artifactWriteTarget("Integration", slug, file.path),
        content: file.content,
      });
    }
    if (published !== undefined) {
      const retained = new Set(["oim.yml", ...draft.files.map((file) => file.path)]);
      for (const path of await packageFiles(join(root(context), slug))) {
        if (!retained.has(path)) {
          changes.push({
            op: "delete",
            target: artifactWriteTarget("Integration", slug, path),
          });
        }
      }
    }

    const lock = readIntegrationLock(context.soulWriter);
    lock.integrations[slug] = {
      sourceType: "authored",
      manifestPath: `integrations/${slug}/oim.yml`,
      hash: createHash("sha256").update(draft.manifestYaml, "utf8").digest("hex"),
      definition: "oim",
      packageDigest: digest,
    };
    changes.push({
      op: "put",
      target: { kind: "IntegrationsLock" },
      content: serializeIntegrationLock(lock),
    });
    const rollback = inversePublication(context.soulWriter, changes);
    try {
      const publication = await context.soulWriter.apply({
        subject: `soul: ${published === undefined ? "add" : "update"} integration ${slug}`,
        source: "agent",
        actor: context.requestContext?.actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
        businessId: DEPLOYMENT_BUSINESS_ID,
        changes,
      });
      try {
        if (publication.published === false) {
          throw new Error(publication.publicationError ?? "Soul publication did not become active");
        }
        await context.releaseTrust.recordInstalledProvenance({
          authorization,
          businessId: DEPLOYMENT_BUSINESS_ID,
          source: "integration_draft_create",
          originalRequirements: draft.manifest,
          autoPatchOptIn: false,
        });
        const stored = await context.releaseTrust.installedProvenance(
          DEPLOYMENT_BUSINESS_ID,
          slug,
          majorVersion(draft.manifest)
        );
        if (
          stored === null ||
          stored.integrationId !== slug ||
          stored.version !== draft.manifest.metadata.version ||
          stored.packageDigest !== digest ||
          stored.trustClass !== "community" ||
          stored.approvedCommunityDigest !== digest
        ) {
          throw new Error("durable provenance does not match the reviewed Community package");
        }
      } catch (error) {
        try {
          await context.soulWriter.apply({
            subject: `soul: ${published === undefined ? "add" : "update"} integration ${slug} rollback`,
            source: "agent",
            actor: context.requestContext?.actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
            businessId: DEPLOYMENT_BUSINESS_ID,
            changes: rollback,
            expectedBaseCommit: publication.commitSha,
          });
        } catch (rollbackError) {
          return err(
            "unavailable",
            `OIM provenance persistence failed and Soul rollback failed: ${reason(error)}; ${reason(rollbackError)}`
          );
        }
        return err(
          "unavailable",
          `OIM provenance persistence failed; Soul publication was reverted: ${reason(error)}`
        );
      }
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
    const files = await Promise.all(
      (manifest.files ?? []).map(async (file) => ({
        path: file.path,
        role: file.role,
        content: await readFile(join(directory, file.path), "utf8").catch(() => ""),
      }))
    );
    const companions = new Map(files.map((file) => [file.path, file.content]));
    const issues = oimPackageIssues(manifest, companions);
    if (issues.length > 0) {
      return err("validation_error", `Published package is invalid: ${issues.join("; ")}`);
    }
    const setupGuide = files.find(
      (file) => file.role === "guide" && file.path === "setup-guide.md"
    )?.content;
    return ok({
      slug,
      definition: "oim",
      manifest: source,
      files,
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
