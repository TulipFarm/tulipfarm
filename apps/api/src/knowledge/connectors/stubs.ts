import type { Connector, ConnectorChanges, ConnectorPage, ConnectorRecord } from "./types";

/**
 * Compatibility shims for the legacy flat-page connector registry. Notion and Google Docs now
 * sync through the ACL-preserving `knowledge_source_*` pipeline in `knowledge-sources/k3-*`; the
 * old connector interface cannot express per-user source ACLs, so these are intentionally inert.
 */
abstract class KnowledgeSourcePipelineConnector implements Connector {
  abstract readonly name: string;

  async authenticate(): Promise<void> {
    return;
  }

  async listChanged(cursor: string | null): Promise<ConnectorChanges> {
    return { ids: [], cursor };
  }

  async fetch(id: string): Promise<ConnectorRecord> {
    return { id };
  }

  mapToPage(record: ConnectorRecord): ConnectorPage {
    return {
      kind: "flat",
      input: {
        source: "resource",
        sourceId: `${this.name}:${record.id}`,
        title: String(record.id),
        content: "",
      },
    };
  }
}

export class GoogleDocsConnector extends KnowledgeSourcePipelineConnector {
  readonly name = "google-docs";
}

export class NotionConnector extends KnowledgeSourcePipelineConnector {
  readonly name = "notion";
}
