import { SampleConnector } from "./sample";
import { GoogleDocsConnector, NotionConnector } from "./stubs";
import { ConnectorRegistry } from "./types";

/**
 * The connectors this process knows about: the working SampleConnector plus inert compatibility
 * shims for providers that moved to the ACL-preserving `knowledge_source_*` pipeline.
 * Confluence/Notion/Google Docs/Drive sync through `knowledge-sources/*` instead because this
 * legacy flat-page registry cannot express per-user source ACLs.
 * Registered does not mean enabled — sync only runs connectors flagged enabled in
 * `knowledge_connectors`.
 */
export function buildDefaultRegistry(): ConnectorRegistry {
  return new ConnectorRegistry([
    new SampleConnector(),
    new GoogleDocsConnector(),
    new NotionConnector(),
  ]);
}
