import { SampleConnector } from "./sample";
import { ConnectorRegistry } from "./types";

/** Legacy flat-page connectors; ACL-preserving providers sync through `knowledge-sources/*`. */
export function buildDefaultRegistry(): ConnectorRegistry {
  return new ConnectorRegistry([new SampleConnector()]);
}
