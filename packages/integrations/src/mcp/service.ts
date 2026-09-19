import {
  type McpDiscovery,
  McpError,
  type McpPromptHandle,
  type McpResourceHandle,
  type McpToolHandle,
} from "@tulipfarm/mcp";
import { ajv, canonicalHash, validateMcpIntegrationDefinition } from "@tulipfarm/schema";
import { McpAccountAccessError } from "../accounts/authority";
import {
  emptyMcpReview,
  type McpCapabilityReview,
  type McpConfigure,
  type McpIntegrationDefinition,
} from "./definition";
import { McpIntegrationError } from "./errors";
import type {
  McpAccessAudit,
  McpAccountAccess,
  McpCaller,
  McpCapability,
  McpDefinitionStore,
  McpExecutionBinding,
  McpSession,
} from "./ports";

type Handle = McpToolHandle | McpResourceHandle | McpPromptHandle;

export function mcpCapabilityDigest(handle: Handle): string {
  const { identity: _identity, kind: _kind, ...capability } = handle;
  return canonicalHash(capability);
}

export function mcpServerRevision(definition: McpIntegrationDefinition): string {
  return canonicalHash(definition);
}

function reviewOf(discovery: McpDiscovery): McpCapabilityReview {
  return {
    tools: discovery.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description.slice(0, 2_000) } : {}),
      inputSchema: { ...tool.inputSchema },
      digest: mcpCapabilityDigest(tool),
      mutating: true,
      requiresApproval: true,
    })),
    resources: discovery.resources.map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      digest: mcpCapabilityDigest(resource),
    })),
    prompts: discovery.prompts.map((prompt) => ({
      name: prompt.name,
      digest: mcpCapabilityDigest(prompt),
      ...(prompt.arguments === undefined ? {} : { arguments: [...prompt.arguments] }),
    })),
  };
}

function accountError(error: unknown): unknown {
  if (error instanceof McpError && error.code === "authentication_required") {
    return new McpIntegrationError("reconnect_required", "Reconnect the selected MCP account.");
  }
  if (error instanceof McpError && error.code === "access_denied") {
    return new McpIntegrationError("forbidden", "The selected MCP account no longer has access.");
  }
  if (!(error instanceof McpAccountAccessError)) return error;
  const code =
    error.code === "account_selection_required"
      ? "selection_required"
      : error.code === "shared_consent_required"
        ? "consent_required"
        : ["account_required", "account_expired", "account_unavailable"].includes(error.code)
          ? "reconnect_required"
          : "forbidden";
  return new McpIntegrationError(code, error.code.replaceAll("_", " "));
}

export class McpIntegrationService<Actor> {
  constructor(
    private readonly definitions: McpDefinitionStore<Actor>,
    private readonly accounts: McpAccountAccess,
    private readonly audit: McpAccessAudit
  ) {}

  list(): readonly McpIntegrationDefinition[] {
    return this.definitions.list();
  }

  get(id: string): McpIntegrationDefinition {
    const definition = this.definitions.get(id);
    if (!definition) throw new McpIntegrationError("not_found", "MCP server not found.");
    return definition;
  }

  async configure(id: string, input: McpConfigure, actor: Actor) {
    if (id !== input.server.id || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) {
      throw new McpIntegrationError("invalid_definition", "The server id must match its slug.");
    }
    if (id === "github" || id === "slack") {
      throw new McpIntegrationError(
        "invalid_definition",
        "The Integration slug is reserved for a native channel."
      );
    }
    const previous = this.definitions.get(id);
    const unchanged = previous && canonicalHash(previous.server) === canonicalHash(input.server);
    const definition: McpIntegrationDefinition = {
      ...input,
      reviewed: unchanged ? previous.reviewed : emptyMcpReview(),
      ...(previous?.reviewPolicy
        ? { reviewPolicy: previous.reviewPolicy }
        : previous && Object.values(previous.reviewed).some((items) => items.length > 0)
          ? { reviewPolicy: "custom" as const }
          : !previous
            ? { reviewPolicy: "uninitialized" as const }
            : {}),
    };
    await this.definitions.put(definition, actor, previous ? mcpServerRevision(previous) : null);
    return definition;
  }

  async remove(id: string, actor: Actor): Promise<void> {
    const definition = this.get(id);
    await this.definitions.remove(id, actor, mcpServerRevision(definition));
  }

  async discover(id: string, caller: McpCaller, signal?: AbortSignal) {
    const definition = this.get(id);
    return await this.session(
      definition,
      caller,
      { kind: "discovery", name: "*" },
      async (client) => reviewOf(await client.discover({ signal })),
      undefined,
      signal
    );
  }

  async review(id: string, review: McpCapabilityReview, caller: McpCaller, actor: Actor) {
    const definition = this.get(id);
    const discovered = await this.discover(id, caller);
    for (const kind of ["tools", "resources", "prompts"] as const) {
      const offered = new Map(
        discovered[kind].map((item) => ["uri" in item ? item.uri : item.name, item])
      );
      const seen = new Set<string>();
      for (const requested of review[kind]) {
        const key = "uri" in requested ? requested.uri : requested.name;
        const current = offered.get(key);
        if (!current || current.digest !== requested.digest || seen.has(key)) {
          throw new McpIntegrationError(
            "capability_changed",
            "Discover and review capabilities again."
          );
        }
        const expected =
          kind === "tools" && "mutating" in requested
            ? {
                ...current,
                mutating: requested.mutating,
                requiresApproval: requested.requiresApproval,
              }
            : current;
        if (canonicalHash(expected) !== canonicalHash(requested)) {
          throw new McpIntegrationError(
            "capability_changed",
            "The reviewed capability does not match discovery."
          );
        }
        seen.add(key);
      }
    }
    for (const tool of review.tools) {
      try {
        ajv.compile(tool.inputSchema);
      } catch {
        throw new McpIntegrationError(
          "unsupported",
          "A discovered Tool has an unsupported input schema."
        );
      }
    }
    if (mcpServerRevision(this.get(id)) !== mcpServerRevision(definition)) {
      throw new McpIntegrationError(
        "capability_changed",
        "Server configuration changed during review."
      );
    }
    const updated = { ...definition, reviewed: review, reviewPolicy: "custom" as const };
    await this.definitions.put(updated, actor, mcpServerRevision(definition));
    return updated;
  }

  async publishSetup(
    definition: McpIntegrationDefinition,
    expectedRevision: string | null,
    actor: Actor
  ): Promise<void> {
    validateMcpIntegrationDefinition(definition);
    for (const tool of definition.reviewed.tools) {
      try {
        ajv.compile(tool.inputSchema);
      } catch {
        throw new McpIntegrationError(
          "unsupported",
          "A discovered Tool has an unsupported input schema."
        );
      }
    }
    const put =
      this.definitions.resumePut?.bind(this.definitions) ??
      this.definitions.put.bind(this.definitions);
    await put(definition, actor, expectedRevision);
    if (mcpServerRevision(this.get(definition.server.id)) !== mcpServerRevision(definition)) {
      throw new McpIntegrationError(
        "unavailable",
        "Integration publication has not become active."
      );
    }
  }

  async bind(
    id: string,
    caller: McpCaller,
    capability: McpCapability,
    pinned?: McpExecutionBinding
  ): Promise<McpExecutionBinding> {
    const definition = this.get(id);
    this.requireEnabled(definition, capability);
    let binding: McpExecutionBinding;
    try {
      binding = await this.accounts.bind({
        caller,
        server: definition.server,
        serverRevision: mcpServerRevision(definition),
        capability,
        ...(pinned === undefined ? {} : { pinned }),
      });
    } catch (error) {
      throw accountError(error);
    }
    if (
      binding.serverId !== id ||
      binding.serverRevision !== mcpServerRevision(definition) ||
      binding.subjectId !== caller.principal.id ||
      (pinned !== undefined && canonicalHash(pinned) !== canonicalHash(binding))
    ) {
      throw new McpIntegrationError("forbidden", "The authorized account binding changed.");
    }
    return binding;
  }

  async callTool(
    binding: McpExecutionBinding,
    caller: McpCaller,
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ) {
    const definition = this.get(binding.serverId);
    const reviewed = definition.reviewed.tools.find((tool) => tool.name === name);
    return await this.session(
      definition,
      caller,
      { kind: "tool", name },
      async (client, activeBinding) => {
        const handle = (await client.discover({ signal })).tools.find((tool) => tool.name === name);
        this.requireUnchanged(handle, reviewed?.digest);
        await this.revalidate(activeBinding, { kind: "tool", name });
        return await client.callTool(handle, args, { signal });
      },
      binding,
      signal
    );
  }

  async readResource(id: string, caller: McpCaller, uri: string, signal?: AbortSignal) {
    const definition = this.get(id);
    const reviewed = definition.reviewed.resources.find((resource) => resource.uri === uri);
    return await this.session(
      definition,
      caller,
      { kind: "resource", name: uri },
      async (client, binding) => {
        const handle = (await client.discover({ signal })).resources.find(
          (resource) => resource.uri === uri
        );
        this.requireUnchanged(handle, reviewed?.digest);
        await this.revalidate(binding, { kind: "resource", name: uri });
        return await client.readResource(handle, { signal });
      },
      undefined,
      signal
    );
  }

  async renderPrompt(
    id: string,
    caller: McpCaller,
    name: string,
    args: Readonly<Record<string, string>>,
    signal?: AbortSignal
  ) {
    const definition = this.get(id);
    const reviewed = definition.reviewed.prompts.find((prompt) => prompt.name === name);
    return await this.session(
      definition,
      caller,
      { kind: "prompt", name },
      async (client, binding) => {
        const handle = (await client.discover({ signal })).prompts.find(
          (prompt) => prompt.name === name
        );
        this.requireUnchanged(handle, reviewed?.digest);
        await this.revalidate(binding, { kind: "prompt", name });
        return await client.getPrompt(handle, args, { signal });
      },
      undefined,
      signal
    );
  }

  private requireEnabled(definition: McpIntegrationDefinition, capability: McpCapability): void {
    if (capability.kind === "discovery") return;
    if (!definition.enabled)
      throw new McpIntegrationError("disabled", "This MCP server is disabled.");
    const enabled =
      capability.kind === "tool"
        ? definition.reviewed.tools.some((tool) => tool.name === capability.name)
        : capability.kind === "resource"
          ? definition.reviewed.resources.some((resource) => resource.uri === capability.name)
          : definition.reviewed.prompts.some((prompt) => prompt.name === capability.name);
    if (!enabled)
      throw new McpIntegrationError(
        "review_required",
        "This capability has not been reviewed and enabled."
      );
  }

  private requireUnchanged<T extends Handle>(
    handle: T | undefined,
    digest: string | undefined
  ): asserts handle is T {
    if (!handle || !digest || mcpCapabilityDigest(handle) !== digest) {
      throw new McpIntegrationError(
        "capability_changed",
        "The server capability changed and needs admin review."
      );
    }
  }

  private async revalidate(binding: McpExecutionBinding, capability: McpCapability): Promise<void> {
    const current = this.get(binding.serverId);
    this.requireEnabled(current, capability);
    if (mcpServerRevision(current) !== binding.serverRevision) {
      throw new McpIntegrationError(
        "capability_changed",
        "The authorized MCP configuration changed."
      );
    }
    try {
      await this.accounts.revalidate(binding, capability);
    } catch (error) {
      throw accountError(error);
    }
  }

  private async session<T>(
    definition: McpIntegrationDefinition,
    caller: McpCaller,
    capability: McpCapability,
    run: (client: McpSession, binding: McpExecutionBinding) => Promise<T>,
    pinned?: McpExecutionBinding,
    signal?: AbortSignal
  ): Promise<T> {
    let binding: McpExecutionBinding | undefined;
    try {
      binding = await this.bind(definition.server.id, caller, capability, pinned);
      if (binding.serverRevision !== mcpServerRevision(definition)) {
        throw new McpIntegrationError(
          "capability_changed",
          "MCP configuration changed during admission."
        );
      }
      await this.revalidate(binding, capability);
      const activeBinding = binding;
      return await this.accounts.use(activeBinding, definition.server, async (client) => {
        try {
          await client.connect({ signal });
          const output = await run(client, activeBinding);
          await this.revalidate(activeBinding, capability);
          await this.audit.record({
            serverId: definition.server.id,
            caller,
            capability,
            accountId: activeBinding.accountId,
            outcome: "allowed",
          });
          return output;
        } finally {
          await client.close();
        }
      });
    } catch (error) {
      const failure = accountError(error);
      await this.audit.record({
        serverId: definition.server.id,
        caller,
        capability,
        ...(binding === undefined ? {} : { accountId: binding.accountId }),
        outcome: failure instanceof McpIntegrationError ? "refused" : "failed",
        code: failure instanceof McpIntegrationError ? failure.code : "mcp_request_failed",
      });
      throw failure;
    }
  }
}
