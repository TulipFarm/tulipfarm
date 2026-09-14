import {
  createIntegrationAuthoringWorkflow,
  INTEGRATION_AUTHORING_TOOL_POLICIES,
  type InstalledIntegrationGeneration,
  type IntegrationAuthoringInvocation,
  type IntegrationDraftConnectionTestResult,
  type IntegrationDraftStore,
  type ReviewedCommunityIntegrationInstaller,
} from "@tulipfarm/integrations";
import { INTEGRATION_AUTHORING_TOOL_DECLARATIONS, type OimManifest } from "@tulipfarm/schema";
import type { SoulIntegration } from "@tulipfarm/soul";
import { type ApiToolDefinition, defineApiTool, type RequestContext } from "@tulipfarm/tool-host";

export type {
  IntegrationDraftConnectionTestResult,
  ReviewedCommunityIntegrationInstaller,
} from "@tulipfarm/integrations";

export interface IntegrationAuthoringToolContext {
  readonly businessId: string;
  readonly drafts: IntegrationDraftStore;
  readonly integrations: () => ReadonlyMap<string, SoulIntegration>;
  readonly installedGenerations: {
    findInstalledGeneration(
      businessId: string,
      integrationId: string,
      majorVersion: number
    ): Promise<InstalledIntegrationGeneration | null>;
  };
  readonly requestContext: RequestContext;
  readonly installer?: ReviewedCommunityIntegrationInstaller;
  readonly connectionTester?: {
    test(input: {
      readonly manifest: OimManifest;
      readonly companions: ReadonlyMap<string, string>;
      readonly connectionId: string;
      readonly requestContext: RequestContext;
    }): Promise<IntegrationDraftConnectionTestResult>;
  };
}

const SOUL_INTEGRATION_TARGET = "soul.integration";
const [reviewDeclaration, createDeclaration, getDeclaration, listDeclaration] =
  INTEGRATION_AUTHORING_TOOL_DECLARATIONS;

function stringArg(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integrationTargets(args: unknown) {
  const slug = stringArg(args, "slug");
  return slug === undefined ? [] : [{ type: SOUL_INTEGRATION_TARGET, id: slug }];
}

function requestPrincipal(requestContext: RequestContext): {
  readonly kind: string;
  readonly id: string;
} {
  return requestContext.subject ?? { kind: "user", id: requestContext.userId };
}

function workflow(context: IntegrationAuthoringToolContext) {
  const connectionTester = context.connectionTester;
  return createIntegrationAuthoringWorkflow<RequestContext>({
    drafts: context.drafts,
    integrations: context.integrations,
    installedGenerations: context.installedGenerations,
    ...(context.installer === undefined ? {} : { installer: context.installer }),
    ...(connectionTester === undefined
      ? {}
      : {
          connectionTester: {
            test: ({ connectionContext, ...input }) =>
              connectionTester.test({ ...input, requestContext: connectionContext }),
          },
        }),
  });
}

function invocation(
  context: IntegrationAuthoringToolContext
): IntegrationAuthoringInvocation<RequestContext> {
  return {
    businessId: context.businessId,
    principal: requestPrincipal(context.requestContext),
    ...(context.requestContext.actor === undefined ? {} : { actor: context.requestContext.actor }),
    ...(context.requestContext.runId === undefined ? {} : { runId: context.requestContext.runId }),
    ...(context.requestContext.toolCallId === undefined
      ? {}
      : { toolCallId: context.requestContext.toolCallId }),
    connectionContext: context.requestContext,
  };
}

const review = defineApiTool<IntegrationAuthoringToolContext>({
  ...reviewDeclaration,
  tier: "system",
  authorization: {
    action: INTEGRATION_AUTHORING_TOOL_POLICIES.integration_draft_review.action,
    resources: [SOUL_INTEGRATION_TARGET],
    dataClasses: ["soul_definition"],
  },
  requiresApproval: INTEGRATION_AUTHORING_TOOL_POLICIES.integration_draft_review.requiresApproval,
  handler: (args, context) => workflow(context).review(args, invocation(context)),
});

const create = defineApiTool<IntegrationAuthoringToolContext>({
  ...createDeclaration,
  tier: "system",
  authorization: {
    action: INTEGRATION_AUTHORING_TOOL_POLICIES.integration_draft_create.action,
    resources: [SOUL_INTEGRATION_TARGET],
    targets: integrationTargets,
    dataClasses: ["soul_definition"],
  },
  requiresApproval: INTEGRATION_AUTHORING_TOOL_POLICIES.integration_draft_create.requiresApproval,
  handler: (args, context) => workflow(context).create(args, invocation(context)),
});

const getIntegration = defineApiTool<IntegrationAuthoringToolContext>({
  ...getDeclaration,
  tier: "system",
  authorization: {
    action: INTEGRATION_AUTHORING_TOOL_POLICIES.integration_get.action,
    resources: [SOUL_INTEGRATION_TARGET],
    targets: integrationTargets,
    dataClasses: ["soul_definition"],
  },
  requiresApproval: INTEGRATION_AUTHORING_TOOL_POLICIES.integration_get.requiresApproval,
  handler: (args, context) => workflow(context).get(args),
});

const listIntegrations = defineApiTool<IntegrationAuthoringToolContext>({
  ...listDeclaration,
  tier: "system",
  authorization: {
    action: INTEGRATION_AUTHORING_TOOL_POLICIES.integration_list.action,
    resources: [SOUL_INTEGRATION_TARGET],
    dataClasses: ["soul_definition"],
  },
  requiresApproval: INTEGRATION_AUTHORING_TOOL_POLICIES.integration_list.requiresApproval,
  handler: (_args, context) => workflow(context).list(),
});

export const INTEGRATION_AUTHORING_TOOLS: ApiToolDefinition<IntegrationAuthoringToolContext>[] = [
  review,
  create,
  getIntegration,
  listIntegrations,
];
