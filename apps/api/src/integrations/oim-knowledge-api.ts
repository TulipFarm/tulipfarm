/**
 * The bridge from a Knowledge sync to the provider, taken through the Integration's own registered
 * Tools rather than a second network path.
 *
 * Dispatching this way is the point of the file. The declarative Tool a manifest already publishes
 * carries the Connection resolution, the credential lease, the destination allowlist, the response
 * projection and the opaque pagination token. Opening a direct HTTP client here would reproduce all
 * five badly, and would let a Knowledge Routine reach a provider under authority no Tool granted.
 *
 * Each operation call gets an id derived from the outer Tool call, its ordinal and its semantic
 * request. Replaying the same walk repeats the ids, while a changed operation, parameters or page
 * token cannot adopt an unrelated effect result that occupied the same ordinal.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  NEXT_PAGE_TOKEN_PROPERTY,
  OIM_CONNECTION_ID_ARGUMENT,
  type OimKnowledgeApiPort,
  OimKnowledgeRetryRequiredError,
  PAGE_TOKEN_ARGUMENT,
} from "@tulipfarm/integrations";
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
  readonly connectionId: string;
  /** The caller's own context. The sync acts as whoever asked for it, never as the deployment. */
  readonly ctx: RequestContext;
  readonly newCallId?: () => string;
}

function requestFingerprint(
  operationId: string,
  parameters: Readonly<Record<string, unknown>>,
  pageToken: string | undefined
): string {
  const canonical =
    JSON.stringify({ operationId, pageToken, parameters }, (_key, value: unknown) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0
            )
          )
        : value
    ) ?? "";
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function createRegistryKnowledgeApiPort(
  deps: RegistryKnowledgeApiDeps
): OimKnowledgeApiPort {
  const names = new Map(
    deps.manifest.operations.map((operation) => [operation.id, operation.name])
  );
  const newCallId = deps.newCallId ?? randomUUID;
  const outerCallId = deps.ctx.toolCallId ?? newCallId();
  let callOrdinal = 0;

  return {
    async execute({ operationId, parameters, pageToken }) {
      const name = names.get(operationId);
      if (name === undefined) throw new OimKnowledgeApiError("operation_unknown", operationId);

      const toolName = declarativeToolName(deps.slug, name);
      const tool = deps.registry.getAll().find((candidate) => candidate.name === toolName);
      if (tool === undefined) {
        throw new OimKnowledgeApiError("tool_unavailable", operationId, toolName);
      }

      const args: Record<string, unknown> = {
        ...parameters,
        [OIM_CONNECTION_ID_ARGUMENT]: deps.connectionId,
      };
      if (pageToken !== undefined) args[PAGE_TOKEN_ARGUMENT] = pageToken;

      const fingerprint = requestFingerprint(operationId, parameters, pageToken);
      const toolCallId = `${outerCallId}:knowledge:${callOrdinal}:${fingerprint}`;
      callOrdinal += 1;
      const result = await tool.execute(args, {
        ...deps.ctx,
        toolCallId,
        retryWaitPolicy: "refuse",
      });
      if (result.success !== true) {
        if ("error" in result && result.error.code === "retry_wait_unavailable") {
          throw new OimKnowledgeRetryRequiredError(operationId);
        }
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
