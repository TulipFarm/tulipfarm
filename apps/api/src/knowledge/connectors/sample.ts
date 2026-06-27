import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Connector, ConnectorChanges, ConnectorPage, ConnectorRecord } from "./types";

/** Shape of a record in the sample fixtures file. */
interface SampleRecord {
  id: string;
  title: string;
  body: string;
  /** ISO 8601 timestamp; doubles as the incremental cursor. */
  updatedAt: string;
  tags?: string[];
  domain?: string | null;
}

/** The bundled fixtures file the registry-registered SampleConnector reads by default. */
export function defaultSampleFixturesPath(): string {
  return join(__dirname, "fixtures", "sample.json");
}

/**
 * Reference connector reading a local JSON fixtures file. It exercises the full framework path —
 * incremental `listChanged` (by `updatedAt` cursor), `fetch`, and `mapToPage` to a flat page — so
 * the sync orchestration and indexer can be verified without a live third-party source.
 */
export class SampleConnector implements Connector {
  readonly name = "sample";

  constructor(private readonly fixturesPath: string = defaultSampleFixturesPath()) {}

  async authenticate(): Promise<void> {
    // Local fixtures need no credentials; a real connector would load them from SecretsService here.
  }

  async listChanged(cursor: string | null): Promise<ConnectorChanges> {
    const all = await this.readAll();
    const changed = all.filter((r) => cursor === null || r.updatedAt > cursor);
    // Advance the cursor to the newest record so an unchanged re-sync returns nothing.
    const nextCursor = all.reduce<string | null>(
      (max, r) => (max === null || r.updatedAt > max ? r.updatedAt : max),
      cursor
    );
    return { ids: changed.map((r) => r.id), cursor: nextCursor };
  }

  async fetch(id: string): Promise<ConnectorRecord> {
    const rec = (await this.readAll()).find((r) => r.id === id);
    if (!rec) throw new Error(`sample connector: record not found: ${id}`);
    return rec as unknown as ConnectorRecord;
  }

  mapToPage(record: ConnectorRecord): ConnectorPage {
    const r = record as unknown as SampleRecord;
    return {
      kind: "flat",
      input: {
        source: "resource",
        // Namespaced by connector name so external rows never collide with locally-authored pages.
        sourceId: `${this.name}:${r.id}`,
        title: r.title,
        content: r.body,
        domain: r.domain ?? null,
        tags: r.tags ?? ["sample-connector"],
      },
    };
  }

  private async readAll(): Promise<SampleRecord[]> {
    const raw = await readFile(this.fixturesPath, "utf8");
    return JSON.parse(raw) as SampleRecord[];
  }
}
