import type { IngestSourceInput, WritePageInput } from "../service";

/** Source connector seam; callers must persist checkpoints and cursors. */

/** A raw external record. `id` is the source-local identifier; the rest is connector-specific. */
export interface ConnectorRecord {
  id: string;
  [key: string]: unknown;
}

/** Mapped page write target: flat `ingestSource` or OKF `writePage`. */
export type ConnectorPage =
  | { kind: "flat"; input: IngestSourceInput }
  | { kind: "okf"; input: WritePageInput };

/** What `listChanged` returns: the ids that changed plus the cursor to persist for the next run. */
export interface ConnectorChanges {
  ids: string[];
  /** Opaque resume position for the next sync. Null means start from the beginning. */
  cursor: string | null;
}

export interface Connector {
  /** Stable identifier; also the `knowledge_connectors.name` key and secret namespace. */
  readonly name: string;
  /** Pull and validate credentials (from `SecretsService`, key `connector:{name}:{cred}`). */
  authenticate(): Promise<void>;
  /** Incremental: ids changed since `cursor`, plus the cursor to persist for the next run. */
  listChanged(cursor: string | null): Promise<ConnectorChanges>;
  /** Fetch one record's content by id. */
  fetch(id: string): Promise<ConnectorRecord>;
  /** Pure mapping from an external record to a page write. */
  mapToPage(record: ConnectorRecord): ConnectorPage;
}

/** Thrown by stub connectors whose real implementation has not landed yet. */
export class NotImplementedError extends Error {
  constructor(connector: string, method: string) {
    super(`connector ${connector}: ${method} is not implemented`);
    this.name = "NotImplementedError";
  }
}

/** A tiny in-memory registry of the connectors known to this process. */
export class ConnectorRegistry {
  private readonly byName = new Map<string, Connector>();

  constructor(connectors: Connector[] = []) {
    for (const c of connectors) this.register(c);
  }

  register(connector: Connector): void {
    this.byName.set(connector.name, connector);
  }

  get(name: string): Connector | undefined {
    return this.byName.get(name);
  }

  list(): Connector[] {
    return [...this.byName.values()];
  }
}
