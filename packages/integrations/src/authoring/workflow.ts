import {
  canonicalize,
  type OimCompanionFile,
  type OimManifest,
  oimCompatibilityIssues,
  oimFileDigest,
  oimPackageDigest,
  oimPackageIssues,
  parseOimFixtureSuite,
  parseOimManifest,
  parseYamlDocument,
} from "@tulipfarm/schema";
import { describeOimCapabilities } from "../catalog/review";
import { runOimFixtures } from "../egress/oim-fixtures";
import type { InstalledIntegrationGeneration, IntegrationDraftStore } from "./drafts";

interface DraftFileInput {
  readonly path: string;
  readonly role: OimCompanionFile["role"];
  readonly content: string;
}

export interface IntegrationAuthoringPrincipal {
  readonly kind: string;
  readonly id: string;
}

export interface IntegrationAuthoringActor {
  readonly principalId: string;
  readonly name: string;
  readonly email: string;
}

export interface IntegrationAuthoringInvocation<TConnectionContext> {
  readonly businessId: string;
  readonly principal: IntegrationAuthoringPrincipal;
  readonly actor?: IntegrationAuthoringActor;
  readonly runId?: string;
  readonly toolCallId?: string;
  readonly connectionContext: TConnectionContext;
}

export const INTEGRATION_AUTHORING_TOOL_POLICIES = {
  integration_draft_review: {
    action: "soul.integration.read",
    requiresApproval: false,
  },
  integration_draft_create: {
    action: "soul.integration.author",
    requiresApproval: true,
  },
  integration_get: {
    action: "soul.integration.read",
    requiresApproval: false,
  },
  integration_list: {
    action: "soul.integration.read",
    requiresApproval: false,
  },
} as const;

export interface AuthoredIntegrationView {
  readonly slug: string;
  readonly manifest?: { readonly name?: string };
  readonly oimManifest?: OimManifest;
  readonly setupGuide?: string;
  readonly oimPackageFiles?: Readonly<Record<string, unknown>>;
}

export interface IntegrationDraftConnectionTestResult {
  readonly connectionId: string;
  readonly passed: boolean;
  readonly operationId?: string;
  readonly status?: string;
}

export type IntegrationAuthoringResult =
  | { readonly success: true; readonly data: unknown }
  | {
      readonly success: false;
      readonly error: {
        readonly code:
          | "validation_error"
          | "not_found"
          | "internal_error"
          | "write_denied"
          | "unavailable";
        readonly message: string;
      };
    };

export interface ReviewedCommunityIntegrationInstaller {
  install(input: {
    readonly businessId: string;
    readonly slug: string;
    readonly packageDigest: string;
    readonly principal: IntegrationAuthoringPrincipal;
    readonly runId: string;
    readonly replace: boolean;
  }): Promise<IntegrationAuthoringResult>;
}

export interface IntegrationAuthoringPorts<TConnectionContext> {
  readonly drafts: IntegrationDraftStore;
  readonly integrations: () => ReadonlyMap<string, AuthoredIntegrationView>;
  readonly installedGenerations: {
    findInstalledGeneration(
      businessId: string,
      integrationId: string,
      majorVersion: number
    ): Promise<InstalledIntegrationGeneration | null>;
  };
  readonly installer?: ReviewedCommunityIntegrationInstaller;
  readonly connectionTester?: {
    test(input: {
      readonly manifest: OimManifest;
      readonly companions: ReadonlyMap<string, string>;
      readonly connectionId: string;
      readonly connectionContext: TConnectionContext;
    }): Promise<IntegrationDraftConnectionTestResult>;
  };
}

export interface IntegrationAuthoringWorkflow<TConnectionContext> {
  review(
    args: unknown,
    invocation: IntegrationAuthoringInvocation<TConnectionContext>
  ): Promise<IntegrationAuthoringResult>;
  create(
    args: unknown,
    invocation: IntegrationAuthoringInvocation<TConnectionContext>
  ): Promise<IntegrationAuthoringResult>;
  get(args: unknown): Promise<IntegrationAuthoringResult>;
  list(): Promise<IntegrationAuthoringResult>;
}

function ok(data: unknown): IntegrationAuthoringResult {
  return { success: true, data };
}

function err(
  code: Extract<IntegrationAuthoringResult, { success: false }>["error"]["code"],
  message: string
): IntegrationAuthoringResult {
  return { success: false, error: { code, message } };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringArg(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function draftFiles(args: unknown): DraftFileInput[] {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return [];
  const files = (args as { files?: unknown }).files;
  return Array.isArray(files) ? (files as DraftFileInput[]) : [];
}

function prepareDraftPackage(source: string, files: readonly DraftFileInput[]) {
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) throw new Error(`files: ${file.path} was supplied more than once`);
    paths.add(file.path);
  }

  let document: unknown;
  try {
    document = parseYamlDocument(source);
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
  }

  const manifest = parseOimManifest(canonicalize(candidate));
  const manifestText = canonicalize(manifest);
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
  const authoredHooks =
    (manifest.hooks ?? []).length > 0 ||
    (manifest.files ?? []).some((file) => file.role === "hook");
  const issues = [
    ...(authoredHooks ? ["hooks: an authored package may not declare JavaScript hooks"] : []),
    ...oimPackageIssues(manifest, companions),
  ];
  if (issues.length > 0) throw new Error(issues.join("; "));
  return { manifest, manifestText, companions };
}

function authoringReadinessIssues(
  manifest: OimManifest,
  companions: ReadonlyMap<string, string>
): string[] {
  const issues: string[] = [];
  if (
    !(manifest.files ?? []).some((file) => file.path === "setup-guide.md" && file.role === "guide")
  ) {
    issues.push("files: setup-guide.md must be declared with role guide");
  }

  const coveredOperations = new Set<string>();
  for (const file of manifest.files ?? []) {
    if (file.role !== "fixture") continue;
    const content = companions.get(file.path);
    if (content === undefined) continue;
    try {
      for (const fixture of parseOimFixtureSuite(content).cases) {
        coveredOperations.add(fixture.operationId);
      }
    } catch (error) {
      issues.push(`fixtures: ${file.path} is invalid: ${reason(error)}`);
    }
  }
  for (const operation of manifest.operations) {
    if (!coveredOperations.has(operation.id)) {
      issues.push(`fixtures: operation ${operation.id} has no offline fixture`);
    }
  }
  return issues;
}

export function createIntegrationAuthoringWorkflow<TConnectionContext>(
  ports: IntegrationAuthoringPorts<TConnectionContext>
): IntegrationAuthoringWorkflow<TConnectionContext> {
  return {
    review: async (args, invocation) => {
      const runId = invocation.runId;
      if (runId === undefined) {
        return err("internal_error", "The Integration review Run identity is unavailable.");
      }
      const source = stringArg(args, "manifest");
      if (source === undefined) return err("validation_error", "manifest is required");
      const connectionId = stringArg(args, "connection_id");
      let prepared: ReturnType<typeof prepareDraftPackage>;
      try {
        prepared = prepareDraftPackage(source, draftFiles(args));
      } catch (error) {
        return err("validation_error", reason(error));
      }

      const { manifest, manifestText, companions } = prepared;
      const readinessIssues = authoringReadinessIssues(manifest, companions);
      if (readinessIssues.length > 0) {
        return err("validation_error", readinessIssues.join("; "));
      }
      let fixtures: Awaited<ReturnType<typeof runOimFixtures>>;
      try {
        fixtures = await runOimFixtures(manifest, companions);
      } catch (error) {
        return err("validation_error", `Fixture validation failed: ${reason(error)}`);
      }
      const failures = fixtures.filter((fixture) => !fixture.passed);
      if (failures.length > 0) {
        return err(
          "validation_error",
          failures.map((fixture) => `fixture ${fixture.name} failed: ${fixture.error}`).join("; ")
        );
      }

      let connectionTest: IntegrationDraftConnectionTestResult | undefined;
      if (connectionId !== undefined) {
        if (ports.connectionTester === undefined) {
          return err(
            "unavailable",
            "Draft Connection testing is not configured on this deployment."
          );
        }
        try {
          connectionTest = await ports.connectionTester.test({
            manifest,
            companions,
            connectionId,
            connectionContext: invocation.connectionContext,
          });
        } catch {
          return err("unavailable", "Connection test could not be completed.");
        }
        if (!connectionTest.passed) {
          return err(
            "validation_error",
            `Connection test failed${connectionTest.status ? ` with status ${connectionTest.status}` : ""}.`
          );
        }
      }

      const slug = manifest.metadata.id;
      const packageDigest = oimPackageDigest(manifest);
      const installed = ports.integrations().get(slug);
      const majorVersion = Number(manifest.metadata.version.split(".")[0]);
      let installedGeneration: InstalledIntegrationGeneration | null;
      try {
        installedGeneration = await ports.installedGenerations.findInstalledGeneration(
          invocation.businessId,
          manifest.metadata.id,
          majorVersion
        );
      } catch {
        return err("unavailable", "The installed Integration generation could not be read.");
      }
      if (installed !== undefined && installedGeneration === null) {
        return err(
          "validation_error",
          "The installed Integration is not managed by the Community release installer."
        );
      }
      if (installed === undefined && installedGeneration !== null) {
        return err(
          "unavailable",
          "The installed Integration view changed. Review the package again."
        );
      }
      if (
        installedGeneration !== null &&
        (installedGeneration.businessId !== invocation.businessId ||
          installedGeneration.integrationId !== manifest.metadata.id ||
          installedGeneration.majorVersion !== majorVersion ||
          installedGeneration.slug !== slug)
      ) {
        return err(
          "unavailable",
          "The installed Integration generation is inconsistent. Review the package again."
        );
      }
      if (installedGeneration?.trustClass === "official") {
        return err(
          "write_denied",
          "An Official Integration cannot be replaced by an authored Community package."
        );
      }
      if (
        installed?.oimManifest !== undefined &&
        installedGeneration !== null &&
        (installed.oimManifest.metadata.id !== installedGeneration.integrationId ||
          installed.oimManifest.metadata.version !== installedGeneration.version ||
          oimPackageDigest(installed.oimManifest) !== installedGeneration.packageDigest)
      ) {
        return err(
          "unavailable",
          "The installed Integration view changed. Review the package again."
        );
      }
      const replacementIssues =
        installed === undefined
          ? []
          : installed.oimManifest === undefined
            ? ["the installed Integration is not an OIM package"]
            : oimCompatibilityIssues(installed.oimManifest, manifest);
      const files = (manifest.files ?? []).map((file) => ({
        path: file.path,
        role: file.role,
        content: companions.get(file.path) as string,
      }));
      const draft = ports.drafts.put(packageDigest, {
        slug,
        manifest,
        manifestText,
        files,
        businessId: invocation.businessId,
        principal: invocation.principal,
        runId,
        ...(invocation.toolCallId === undefined ? {} : { toolCallId: invocation.toolCallId }),
        replacement:
          installedGeneration === null
            ? { kind: "none" }
            : { kind: "generation", generation: installedGeneration },
        replacementIssues,
      });

      return ok({
        slug,
        packageDigest,
        reviewId: draft.provenance.reviewId,
        reviewedAt: draft.provenance.reviewedAt,
        manifest: manifestText,
        installed: draft.replacement.kind === "generation",
        replacement:
          draft.replacement.kind === "none"
            ? { kind: "none" }
            : {
                kind: "generation",
                installationId: draft.replacement.generation.installationId,
                version: draft.replacement.generation.version,
                packageDigest: draft.replacement.generation.packageDigest,
              },
        hasSetupGuide: files.some(
          (file) => file.path === "setup-guide.md" && file.role === "guide"
        ),
        fixtures,
        ...(connectionTest === undefined ? {} : { connectionTest }),
        ...(draft.replacementIssues.length === 0
          ? {}
          : { replacementIssues: draft.replacementIssues }),
        review: describeOimCapabilities(manifest),
      });
    },

    create: async (args, invocation) => {
      const slug = stringArg(args, "slug");
      const packageDigest = stringArg(args, "package_digest");
      const replace =
        args !== null &&
        typeof args === "object" &&
        !Array.isArray(args) &&
        (args as { replace?: unknown }).replace === true;
      if (slug === undefined || packageDigest === undefined) {
        return err("validation_error", "slug and package_digest are required");
      }
      const { actor, runId } = invocation;
      if (actor === undefined || runId === undefined) {
        return err("internal_error", "The Integration install invocation identity is unavailable.");
      }
      if (ports.installer === undefined) {
        return err("unavailable", "Community Integration installation is not configured.");
      }
      const draft = ports.drafts.get(packageDigest, {
        businessId: invocation.businessId,
        principal: invocation.principal,
        runId,
      });
      if (draft === undefined) {
        return err(
          "validation_error",
          "The reviewed Integration draft is unavailable or was already spent. Review it again."
        );
      }
      if (oimPackageDigest(draft.manifest) !== packageDigest) {
        return err("internal_error", "The reviewed Integration draft failed its integrity check.");
      }
      if (draft.slug !== slug) {
        return err(
          "validation_error",
          `The reviewed Integration is ${draft.slug}; it cannot be installed as ${slug}.`
        );
      }
      const packageIssues = oimPackageIssues(
        draft.manifest,
        new Map(draft.files.map((file) => [file.path, file.content]))
      );
      if (packageIssues.length > 0) {
        return err("internal_error", "The reviewed Integration draft failed its integrity check.");
      }
      if (draft.replacementIssues.length > 0) {
        return err(
          "validation_error",
          `The reviewed replacement is incompatible: ${draft.replacementIssues.join("; ")}`
        );
      }
      if (replace && draft.replacement.kind === "none") {
        return err(
          "validation_error",
          "No installed Integration generation was reviewed to replace."
        );
      }
      if (!replace && draft.replacement.kind === "generation") {
        return err(
          "validation_error",
          "The reviewed Integration already exists; publish it with replace enabled."
        );
      }

      try {
        return await ports.installer.install({
          businessId: invocation.businessId,
          slug,
          packageDigest,
          principal: invocation.principal,
          runId,
          replace,
        });
      } catch {
        return err("internal_error", "Community Integration installation failed.");
      }
    },

    get: async (args) => {
      const slug = stringArg(args, "slug");
      if (slug === undefined) return err("validation_error", "slug is required");
      const integration = ports.integrations().get(slug);
      if (integration === undefined) {
        return err("not_found", `Integration ${slug} was not found.`);
      }
      return ok({
        slug,
        manifest: integration.manifest,
        oimManifest: integration.oimManifest,
        setupGuide: integration.setupGuide,
        packageFiles: integration.oimPackageFiles,
        ...(integration.oimManifest === undefined
          ? {}
          : { review: describeOimCapabilities(integration.oimManifest) }),
      });
    },

    list: async () =>
      ok(
        [...ports.integrations().values()]
          .map((integration) => ({
            slug: integration.slug,
            kind: integration.oimManifest === undefined ? "legacy" : "oim",
            title:
              integration.oimManifest?.metadata.name ??
              integration.manifest?.name ??
              integration.slug,
          }))
          .sort((left, right) => left.slug.localeCompare(right.slug))
      ),
  };
}
