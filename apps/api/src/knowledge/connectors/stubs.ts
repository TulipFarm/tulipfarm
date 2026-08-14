import type { Connector, ConnectorChanges, ConnectorPage, ConnectorRecord } from "./types";

/** Legacy flat-page connectors are inert; ACL-preserving sync uses knowledge_source_*. */
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
