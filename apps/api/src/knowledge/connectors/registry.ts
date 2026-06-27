import { SampleConnector } from "./sample";
import { ConfluenceConnector, GoogleDocsConnector, NotionConnector } from "./stubs";
import { ConnectorRegistry } from "./types";

/**
 * The connectors this process knows about: the working SampleConnector plus the not-yet-implemented
 * stubs. Registered does not mean enabled — sync only runs connectors flagged enabled in
 * `knowledge_connectors`.
 */
export function buildDefaultRegistry(): ConnectorRegistry {
  return new ConnectorRegistry([
    new SampleConnector(),
    new GoogleDocsConnector(),
    new ConfluenceConnector(),
    new NotionConnector(),
  ]);
}
