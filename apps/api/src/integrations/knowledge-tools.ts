/**
 * The Agent-facing surface of the OIM Knowledge profile.
 *
 * Three Tools, in the order an Agent uses them:
 *
 * - `integration_knowledge_profile` reads what the manifest declares. No network, no provider call.
 *   It exists so an Agent authors an indexing Routine from what the Integration actually supports
 *   instead of inventing scopes, schedules and field names that happen to sound right.
 * - `integration_knowledge_scopes` enumerates the spaces a user picks from, when the provider can.
 * - `integration_knowledge_sync` runs one read-only pass and is what a Routine's Tool State calls.
 *
 * None of them chooses a Connection or a schedule on the user's behalf. Picking a Connection is how
 * personal and organization content end up indexed into one place; picking a schedule is how a
 * provider bill arrives that nobody agreed to.
 */

import {
  compileKnowledgeProfile,
  createOimProviderAccountPort,
  describeKnowledgeProfile,
  type KnowledgeEmissionSink,
  type KnowledgeIdentityPolicy,
  type OimHookPhaseRunner,
  type OimKnowledgeCheckpointStore,
  type OimKnowledgeSyncResult,
  type ProviderIdentityLinkPort,
  readPointer,
  syncOimKnowledge,
  type VerifiedEmailPrincipalPort,
} from "@tulipfarm/integrations";
import { ajv, type OimManifest } from "@tulipfarm/schema";
import type { SoulIntegration } from "@tulipfarm/soul";
import { type ApiToolDefinition, defineApiTool, err, ok } from "@tulipfarm/tool-host";
import type { ToolRegistry } from "../broker/tool-adapter";
import { firstError } from "../platform/tool-args";
import { createRegistryKnowledgeApiPort } from "./oim-knowledge-api";

export interface IntegrationKnowledgeToolContext {
  readonly businessId: string;
  readonly integrations: () => Iterable<SoulIntegration>;
  readonly registry: ToolRegistry;
  readonly checkpoints: OimKnowledgeCheckpointStore;
  readonly sink: KnowledgeEmissionSink;
  readonly links: ProviderIdentityLinkPort;
  readonly emails?: VerifiedEmailPrincipalPort;
  readonly policy: KnowledgeIdentityPolicy;
  readonly oimRuntimeHost: {
    authorizeIntegration(integration: SoulIntegration): Promise<void>;
    hookRunnerFor(input: {
      readonly businessId: string;
      readonly integrationId: string;
      readonly integrationMajorVersion: number;
      readonly manifest: OimManifest;
    }): Promise<OimHookPhaseRunner | undefined>;
  };
  /** The caller, so a sync acts as whoever asked for it rather than as the deployment. */
  readonly requestContext: { readonly userId?: string; readonly runId?: string };
  readonly now?: () => Date;
}

const KNOWLEDGE_RESOURCE = "integration.knowledge";

const PROFILE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["integration"],
  properties: { integration: { type: "string", minLength: 1 } },
};

const SCOPES_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["integration", "source_kind", "connection_id"],
  properties: {
    integration: { type: "string", minLength: 1 },
    source_kind: { type: "string", minLength: 1 },
    connection_id: { type: "string", minLength: 1 },
    page_token: { type: "string", minLength: 1 },
  },
};

const SYNC_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["integration", "source_kind", "scopes", "connection_id"],
  properties: {
    integration: { type: "string", minLength: 1 },
    source_kind: { type: "string", minLength: 1 },
    scopes: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: { type: "string", minLength: 1 },
    },
    connection_id: { type: "string", minLength: 1 },
    classification: { type: "array", maxItems: 8, items: { type: "string", minLength: 1 } },
  },
};

const validateProfile = ajv.compile(PROFILE_SCHEMA);
const validateScopes = ajv.compile(SCOPES_SCHEMA);
const validateSync = ajv.compile(SYNC_SCHEMA);

interface ProfileArgs {
  readonly integration: string;
}
interface ScopesArgs extends ProfileArgs {
  readonly source_kind: string;
  readonly connection_id: string;
  readonly page_token?: string;
}
interface SyncArgs extends ProfileArgs {
  readonly source_kind: string;
  readonly scopes: readonly string[];
  readonly connection_id: string;
  readonly classification?: readonly string[];
}

function installed(
  ctx: IntegrationKnowledgeToolContext,
  slug: string
): SoulIntegration | undefined {
  for (const integration of ctx.integrations()) {
    if (integration.slug === slug) return integration;
  }
  return undefined;
}

/**
 * Resolves the manifest, or the reason an Agent cannot proceed.
 *
 * Connection state is durable and checked by each provider operation. The Soul's legacy
 * `connection.enabled` flag is not evidence that a current Connection exists.
 */
function manifestFor(
  ctx: IntegrationKnowledgeToolContext,
  slug: string
): { readonly integration: SoulIntegration } | { readonly problem: string } {
  const integration = installed(ctx, slug);
  if (integration === undefined) return { problem: `no Integration "${slug}" is installed` };
  if (integration.oimManifest === undefined) {
    return { problem: `Integration "${slug}" publishes no Open Integration Manifest` };
  }
  if (integration.oimManifest.knowledge === undefined) {
    return { problem: `Integration "${slug}" declares no knowledge profile` };
  }
  return { integration };
}

export const integrationKnowledgeProfileTool = defineApiTool<IntegrationKnowledgeToolContext>({
  name: "integration_knowledge_profile",
  description:
    "Read what an Integration's Knowledge profile can index: the kinds of content it exposes, " +
    "which of them the provider can enumerate, who its permissions grant to, whether deletions " +
    "propagate, and what must be settled with the user before an indexing Routine is authored. " +
    "Reads the manifest only — no provider call, no indexing.",
  tier: "system",
  mutating: false,
  inputSchema: PROFILE_SCHEMA,
  authorization: {
    action: "integration.knowledge.describe",
    resources: [KNOWLEDGE_RESOURCE],
    dataClasses: ["operational"],
  },
  handler: async (args, ctx) => {
    if (!validateProfile(args)) return err("validation_error", firstError(validateProfile.errors));
    const { integration: slug } = args as ProfileArgs;
    const resolved = manifestFor(ctx, slug);
    if ("problem" in resolved) return err("not_found", resolved.problem);
    const manifest = resolved.integration.oimManifest;
    if (manifest === undefined) return err("not_found", `Integration "${slug}" has no manifest`);
    try {
      await ctx.oimRuntimeHost.authorizeIntegration(resolved.integration);
    } catch {
      return err("unavailable", `Integration "${slug}" release is not authorized`);
    }
    try {
      const description = describeKnowledgeProfile(manifest);
      return ok({
        ...description,
        // The guide is the provider-specific sequencing, cost and rate-limit advice the manifest
        // author wrote. Serving it here is what stops an Agent guessing at it.
        ...(resolved.integration.knowledgeGuide === undefined
          ? {}
          : { guide: resolved.integration.knowledgeGuide }),
      });
    } catch (error) {
      return err(
        "validation_error",
        `Integration "${slug}" has an unusable knowledge profile: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  },
});

export const integrationKnowledgeScopesTool = defineApiTool<IntegrationKnowledgeToolContext>({
  name: "integration_knowledge_scopes",
  description:
    "List the scopes — spaces, folders, channels or labels — a user can choose to index for one " +
    "source kind, when the Integration declares a way to enumerate them. Returns a page at a " +
    "time; pass the returned page_token to continue. Indexes nothing.",
  tier: "system",
  mutating: false,
  inputSchema: SCOPES_SCHEMA,
  authorization: {
    action: "integration.knowledge.discover",
    resources: [KNOWLEDGE_RESOURCE],
    dataClasses: ["source_content"],
  },
  handler: async (args, ctx) => {
    if (!validateScopes(args)) return err("validation_error", firstError(validateScopes.errors));
    const input = args as ScopesArgs;
    const resolved = manifestFor(ctx, input.integration);
    if ("problem" in resolved) return err("not_found", resolved.problem);
    const manifest = resolved.integration.oimManifest;
    if (manifest === undefined) return err("not_found", "no manifest");
    try {
      await ctx.oimRuntimeHost.authorizeIntegration(resolved.integration);
    } catch {
      return err("unavailable", `Integration "${input.integration}" release is not authorized`);
    }

    const plan = compileKnowledgeProfile(manifest);
    const kind = plan.sourceKinds.find((candidate) => candidate.id === input.source_kind);
    if (kind === undefined) {
      return err(
        "validation_error",
        `"${input.source_kind}" is not a source kind of "${input.integration}"; ` +
          `known kinds: ${plan.sourceKinds.map((k) => k.id).join(", ")}`
      );
    }
    if (kind.discover === undefined) {
      return err(
        "validation_error",
        `"${input.source_kind}" cannot be enumerated; the user must name the scopes themselves`
      );
    }

    const api = createRegistryKnowledgeApiPort({
      slug: input.integration,
      manifest,
      registry: ctx.registry,
      ctx: { userId: ctx.requestContext.userId ?? "", ...ctx.requestContext },
      connectionId: input.connection_id,
    });
    let page: { readonly body: unknown; readonly nextPageToken?: string };
    try {
      page = await api.execute({
        operationId: kind.discover.operation.id,
        parameters: {},
        ...(input.page_token === undefined ? {} : { pageToken: input.page_token }),
      });
    } catch (error) {
      return err("unavailable", error instanceof Error ? error.message : String(error));
    }

    const raw = readPointer(page.body, kind.discover.itemsPointer);
    if (!Array.isArray(raw)) {
      return err("internal_error", "the provider returned no list of scopes");
    }
    const scopes = raw.flatMap((entry) => {
      const id = readPointer(entry, kind.discover?.idPointer ?? "");
      const label = readPointer(entry, kind.discover?.labelPointer ?? "");
      if (typeof id !== "string" && typeof id !== "number") return [];
      return [{ id: String(id), label: typeof label === "string" ? label : String(id) }];
    });
    return ok({
      scopes,
      ...(page.nextPageToken === undefined ? {} : { page_token: page.nextPageToken }),
    });
  },
});

export const integrationKnowledgeSyncTool = defineApiTool<IntegrationKnowledgeToolContext>({
  name: "integration_knowledge_sync",
  description:
    "Run one read-only indexing pass over the named scopes of an Integration, through one exact " +
    "Connection. Resumes from where the last pass stopped, reads each item's permissions before " +
    "its content, and removes content the provider says is gone. Returns per-scope counts and " +
    "failures. Intended to be called from a scheduled Routine, not ad hoc.",
  tier: "system",
  mutating: true,
  inputSchema: SYNC_SCHEMA,
  authorization: {
    action: "integration.knowledge.sync",
    resources: [KNOWLEDGE_RESOURCE],
    dataClasses: ["source_content"],
  },
  handler: async (args, ctx) => {
    if (!validateSync(args)) return err("validation_error", firstError(validateSync.errors));
    const input = args as SyncArgs;
    const resolved = manifestFor(ctx, input.integration);
    if ("problem" in resolved) return err("not_found", resolved.problem);
    const manifest = resolved.integration.oimManifest;
    if (manifest === undefined) return err("not_found", "no manifest");

    let plan: ReturnType<typeof compileKnowledgeProfile>;
    try {
      plan = compileKnowledgeProfile(manifest);
    } catch (error) {
      return err(
        "validation_error",
        `Integration "${input.integration}" has an unusable knowledge profile: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    if (!plan.sourceKinds.some((kind) => kind.id === input.source_kind)) {
      return err(
        "validation_error",
        `"${input.source_kind}" is not a source kind of "${input.integration}"`
      );
    }

    const api = createRegistryKnowledgeApiPort({
      slug: input.integration,
      manifest,
      registry: ctx.registry,
      ctx: { userId: ctx.requestContext.userId ?? "", ...ctx.requestContext },
      connectionId: input.connection_id,
    });
    let result: OimKnowledgeSyncResult;
    try {
      const hookRunner = await ctx.oimRuntimeHost.hookRunnerFor({
        businessId: ctx.businessId,
        integrationId: plan.integrationId,
        integrationMajorVersion: plan.majorVersion,
        manifest,
      });
      result = await syncOimKnowledge(
        plan,
        {
          api,
          checkpoints: ctx.checkpoints,
          sink: ctx.sink,
          identity: {
            links: ctx.links,
            ...(ctx.emails === undefined ? {} : { emails: ctx.emails }),
            accounts: createOimProviderAccountPort(plan, api),
            policy: ctx.policy,
          },
          ...(hookRunner === undefined ? {} : { hookRunner }),
          now: ctx.now ?? (() => new Date()),
        },
        {
          businessId: ctx.businessId,
          integrationId: input.integration,
          connectionId: input.connection_id,
          sourceKindId: input.source_kind,
          scopes: input.scopes,
          ...(input.classification === undefined ? {} : { classification: input.classification }),
        }
      );
    } catch (error) {
      return err("unavailable", error instanceof Error ? error.message : String(error));
    }
    return ok(result);
  },
});

export const INTEGRATION_KNOWLEDGE_TOOLS: ApiToolDefinition<IntegrationKnowledgeToolContext>[] = [
  integrationKnowledgeProfileTool,
  integrationKnowledgeScopesTool,
  integrationKnowledgeSyncTool,
];
