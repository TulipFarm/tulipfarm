/**
 * The bridge from a Knowledge sync to the provider, taken through the Integration's own registered
 * Tools rather than a second network path.
 *
 * Dispatching this way is the point of the file. The declarative Tool a manifest already publishes
 * carries the Connection resolution, the credential lease, the destination allowlist, the response
 * projection and the opaque pagination token. Opening a direct HTTP client here would reproduce all
 * five badly, and would let a Knowledge Routine reach a provider under authority no Tool granted.
 *
 * Each operation call is given its own `toolCallId`. The declarative handler derives its effect id
 * from the call id, so reusing one would make the second page of a walk look like a replay of the
 * first and return the earlier page forever.
 */

import { randomUUID } from "node:crypto";
import type { OimKnowledgeApiPort } from "@tulipfarm/integrations";
import { NEXT_PAGE_TOKEN_PROPERTY, PAGE_TOKEN_ARGUMENT } from "@tulipfarm/integrations";
import type { OimManifest } from "@tulipfarm/schema";
import type { RequestContext } from "@tulipfarm/tool-host";
import type { ToolRegistry } from "../broker/tool-adapter";
import { declarativeToolName } from "../tools/declarative/tools";

export class OimKnowledgeApiError extends Error {
  constructor(
    readonly code: "operation_unknown" | "tool_unavailable" | "call_failed" | "parked",
    readonly operationId: string,
    detail?: string
  ) {
    super(`${code} for operation "${operationId}"${detail === undefined ? "" : `: ${detail}`}`);
    this.name = "OimKnowledgeApiError";
  }
}

export interface RegistryKnowledgeApiDeps {
  readonly slug: string;
  readonly manifest: OimManifest;
  readonly registry: ToolRegistry;
  /** The caller's own context. The sync acts as whoever asked for it, never as the deployment. */
  readonly ctx: RequestContext;
  readonly newCallId?: () => string;
}

export function createRegistryKnowledgeApiPort(
  deps: RegistryKnowledgeApiDeps
): OimKnowledgeApiPort {
  const names = new Map(
    deps.manifest.operations.map((operation) => [operation.id, operation.name])
  );
  const newCallId = deps.newCallId ?? randomUUID;

  return {
    async execute({ operationId, parameters, pageToken }) {
      const name = names.get(operationId);
      if (name === undefined) throw new OimKnowledgeApiError("operation_unknown", operationId);

      const toolName = declarativeToolName(deps.slug, name);
      const tool = deps.registry.getAll().find((candidate) => candidate.name === toolName);
      if (tool === undefined) {
        throw new OimKnowledgeApiError("tool_unavailable", operationId, toolName);
      }

      const args: Record<string, unknown> = { ...parameters };
      if (pageToken !== undefined) args[PAGE_TOKEN_ARGUMENT] = pageToken;

      const result = await tool.execute(args, { ...deps.ctx, toolCallId: newCallId() });
      if (result.success !== true) {
        // A parked call has no verdict at all, so it is neither a page nor an error the sync can
        // interpret. Both land here as a failure the sync records against exactly this scope.
        const detail = "error" in result ? result.error.message : "parked";
        throw new OimKnowledgeApiError(
          "parked" in result ? "parked" : "call_failed",
          operationId,
          detail
        );
      }

      const body = result.data;
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return { body };
      }
      const token = (body as Record<string, unknown>)[NEXT_PAGE_TOKEN_PROPERTY];
      return {
        body,
        ...(typeof token === "string" && token.length > 0 ? { nextPageToken: token } : {}),
      };
    },
  };
}
