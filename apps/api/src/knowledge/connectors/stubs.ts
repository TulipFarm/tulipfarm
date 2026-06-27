import type { Connector, ConnectorChanges, ConnectorPage, ConnectorRecord } from "./types";
import { NotImplementedError } from "./types";

/**
 * Honest stubs for the connectors a future PR will implement. Each one fully satisfies the
 * `Connector` interface but throws `NotImplementedError` from every method — so they register and
 * appear in the framework today, and landing a real connector means filling in these 3–4 methods
 * without touching the indexer or sync orchestration.
 */
abstract class StubConnector implements Connector {
  abstract readonly name: string;

  authenticate(): Promise<void> {
    throw new NotImplementedError(this.name, "authenticate");
  }

  listChanged(_cursor: string | null): Promise<ConnectorChanges> {
    throw new NotImplementedError(this.name, "listChanged");
  }

  fetch(_id: string): Promise<ConnectorRecord> {
    throw new NotImplementedError(this.name, "fetch");
  }

  mapToPage(_record: ConnectorRecord): ConnectorPage {
    throw new NotImplementedError(this.name, "mapToPage");
  }
}

export class GoogleDocsConnector extends StubConnector {
  readonly name = "google-docs";
}

export class ConfluenceConnector extends StubConnector {
  readonly name = "confluence";
}

export class NotionConnector extends StubConnector {
  readonly name = "notion";
}
