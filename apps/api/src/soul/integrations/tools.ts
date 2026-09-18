import {
  type McpCaller,
  type McpCapabilityReview,
  type McpConfigure,
  McpIntegrationError,
  type McpIntegrationService,
} from "@tulipfarm/integrations";
import { McpError } from "@tulipfarm/mcp";
import {
  ajv,
  INTEGRATION_CONFIGURE_TOOL_DECLARATION,
  INTEGRATION_DISCOVER_TOOL_DECLARATION,
  INTEGRATION_GET_TOOL_DECLARATION,
  INTEGRATION_LIST_TOOL_DECLARATION,
  INTEGRATION_PROMPT_RENDER_TOOL_DECLARATION,
  INTEGRATION_RESOURCE_READ_TOOL_DECLARATION,
  INTEGRATION_REVIEW_TOOL_DECLARATION,
  type McpSetupToolDeclaration,
} from "@tulipfarm/schema";
import { type CommitActor, isSoulWriteError } from "@tulipfarm/soul";
import {
  type ApiToolDefinition,
  defineApiTool,
  err,
  ok,
  type RequestContext,
  type ToolCallResult,
} from "@tulipfarm/tool-host";

export interface IntegrationAuthoringToolContext {
  readonly service: McpIntegrationService<CommitActor>;
  readonly caller: (request: RequestContext) => Promise<McpCaller>;
  readonly requestContext: RequestContext;
}

function actor(context: IntegrationAuthoringToolContext): CommitActor {
  if (!context.requestContext.actor) {
    throw new McpIntegrationError("forbidden", "An authenticated Soul author is required.");
  }
  return context.requestContext.actor;
}

function definition<T>(
  declaration: McpSetupToolDeclaration,
  run: (input: T, context: IntegrationAuthoringToolContext) => Promise<unknown>
): ApiToolDefinition<IntegrationAuthoringToolContext> {
  const { name, description, inputSchema, mutating } = declaration;
  const validate = ajv.compile<T>(inputSchema);
  return defineApiTool({
    name,
    description,
    inputSchema,
    mutating,
    tier: "system",
    requiresApproval: mutating,
    requiresAmbient: ["soul"],
    authorization: {
      action: mutating ? "integration.connect" : "integration.read",
      resources: ["integration"],
      dataClasses: ["soul_definition"],
    },
    async handler(args, context): Promise<ToolCallResult> {
      if (!validate(args)) return err("validation_error", "The Integration arguments are invalid.");
      try {
        return ok(await run(args, context));
      } catch (error) {
        if (error instanceof McpIntegrationError) {
          const accountAction = [
            "selection_required",
            "consent_required",
            "reconnect_required",
          ].includes(error.code);
          return err(
            accountAction
              ? "credential_required"
              : error.code === "not_found"
                ? "not_found"
                : "write_denied",
            `${error.code}: ${error.message}`,
            accountAction ? "/integrations" : undefined
          );
        }
        if (error instanceof McpError) return err("unavailable", error.message);
        if (isSoulWriteError(error)) return err("write_denied", error.message);
        throw error;
      }
    },
  });
}

export const INTEGRATION_AUTHORING_TOOLS = [
  definition<Record<string, never>>(INTEGRATION_LIST_TOOL_DECLARATION, async (_input, context) => ({
    servers: context.service.list(),
  })),
  definition<{ slug: string }>(INTEGRATION_GET_TOOL_DECLARATION, async (input, context) => ({
    server: context.service.get(input.slug),
  })),
  definition<{ slug: string; configuration: McpConfigure }>(
    INTEGRATION_CONFIGURE_TOOL_DECLARATION,
    async (input, context) => ({
      server: await context.service.configure(input.slug, input.configuration, actor(context)),
    })
  ),
  definition<{ slug: string }>(INTEGRATION_DISCOVER_TOOL_DECLARATION, async (input, context) => ({
    capabilities: await context.service.discover(
      input.slug,
      await context.caller(context.requestContext),
      context.requestContext.abortSignal
    ),
  })),
  definition<{ slug: string; capabilities: McpCapabilityReview }>(
    INTEGRATION_REVIEW_TOOL_DECLARATION,
    async (input, context) => ({
      server: await context.service.review(
        input.slug,
        input.capabilities,
        await context.caller(context.requestContext),
        actor(context)
      ),
    })
  ),
  definition<{ slug: string; uri: string }>(
    INTEGRATION_RESOURCE_READ_TOOL_DECLARATION,
    async (input, context) =>
      context.service.readResource(
        input.slug,
        await context.caller(context.requestContext),
        input.uri,
        context.requestContext.abortSignal
      )
  ),
  definition<{ slug: string; name: string; arguments?: Record<string, string> }>(
    INTEGRATION_PROMPT_RENDER_TOOL_DECLARATION,
    async (input, context) =>
      context.service.renderPrompt(
        input.slug,
        await context.caller(context.requestContext),
        input.name,
        input.arguments ?? {},
        context.requestContext.abortSignal
      )
  ),
] satisfies ApiToolDefinition<IntegrationAuthoringToolContext>[];
