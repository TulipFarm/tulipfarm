import {
  canonicalHash,
  type McpIntegrationDefinition,
  validateMcpIntegrationDefinition,
} from "@tulipfarm/schema";
import { stringify as stringifyYaml } from "yaml";
import type { CommitActor } from "../commit-signing";
import { SoulPublicationError } from "../publication-error";
import type { SoulLoader } from "../published-loader";
import {
  SoulWriteError,
  type SoulWriteResult,
  type SoulWriter,
  type SoulWriteTarget,
} from "../writer";
import { MCP_DEFINITION_FILE, parseMcpSoulDefinition } from "./mcp-definition";

export interface SoulMcpDefinitionStoreOptions {
  /** An active-bundle view; the authored loader can include committed but unpublished changes. */
  readonly loader: Pick<SoulLoader, "integrations">;
  readonly soulWriter: Pick<
    SoulWriter,
    "apply" | "read" | "readCompanion" | "readCompanionWithBase" | "revision"
  >;
  readonly businessId: string;
}

function requirePublished(result: SoulWriteResult): void {
  if (!result.published) {
    throw new SoulPublicationError(
      "ACTIVATION_FAILED",
      "MCP configuration was committed but could not be published"
    );
  }
}

/** Implements the Integration definition port without importing the runtime or account owners. */
export function createSoulMcpDefinitionStore(options: SoulMcpDefinitionStoreOptions) {
  const { soulWriter, loader, businessId } = options;

  function target(id: string): SoulWriteTarget {
    return { kind: "Integration", slug: id, companion: MCP_DEFINITION_FILE };
  }

  async function readForWrite(id: string, expectedRevision?: string | null) {
    const writeTarget = target(id);
    const before = await soulWriter.revision(writeTarget);
    const snapshot = await soulWriter.readCompanionWithBase("Integration", id, MCP_DEFINITION_FILE);
    const after = await soulWriter.revision(writeTarget);
    if (before !== after) {
      throw new SoulWriteError("CONFLICT", "MCP configuration changed during the read");
    }
    const current = snapshot.content === null ? null : parseMcpSoulDefinition(snapshot.content, id);
    if (
      expectedRevision !== undefined &&
      (current === null ? null : canonicalHash(current)) !== expectedRevision
    ) {
      throw new SoulWriteError("CONFLICT", "MCP configuration changed since it was reviewed");
    }
    return { current, snapshot, revision: after, writeTarget };
  }

  return {
    list(): readonly McpIntegrationDefinition[] {
      return [...loader.integrations.values()].flatMap((integration) =>
        integration.mcp === undefined ? [] : [structuredClone(integration.mcp)]
      );
    },
    get(id: string): McpIntegrationDefinition | undefined {
      const definition = loader.integrations.get(id)?.mcp;
      return definition === undefined ? undefined : structuredClone(definition);
    },
    async put(
      input: McpIntegrationDefinition,
      actor: CommitActor,
      expectedRevision?: string | null
    ): Promise<void> {
      const definition = validateMcpIntegrationDefinition(input);
      const id = definition.server.id;
      const { snapshot, revision, writeTarget } = await readForWrite(id, expectedRevision);
      if (
        id === "slack" ||
        id === "github" ||
        soulWriter.read("Integration", id) !== null ||
        soulWriter.readCompanion("Integration", id, "manifest.yml") !== null ||
        soulWriter.readCompanion("Integration", id, "connection.yaml") !== null
      ) {
        throw new SoulWriteError("CONFLICT", "The Integration slug belongs to a native channel");
      }
      const result = await soulWriter.apply({
        subject: `soul: configure MCP integration ${id}`,
        source: "api",
        actor,
        businessId,
        ...(revision === null || snapshot.content === null
          ? { expectedBaseCommit: snapshot.baseCommit }
          : { expectedRevisions: [{ target: writeTarget, revision }] }),
        changes: [{ op: "put", target: writeTarget, content: stringifyYaml(definition) }],
      });
      requirePublished(result);
    },
    async remove(id: string, actor: CommitActor, expectedRevision?: string | null): Promise<void> {
      const { current, revision, snapshot, writeTarget } = await readForWrite(id, expectedRevision);
      if (current === null) {
        throw new SoulWriteError("PRECONDITION_FAILED", "MCP configuration does not exist");
      }
      const result = await soulWriter.apply({
        subject: `soul: remove MCP integration ${id}`,
        source: "api",
        actor,
        businessId,
        ...(revision === null
          ? { expectedBaseCommit: snapshot.baseCommit }
          : { expectedRevisions: [{ target: writeTarget, revision }] }),
        changes: [{ op: "delete", target: writeTarget }],
      });
      requirePublished(result);
    },
  };
}
