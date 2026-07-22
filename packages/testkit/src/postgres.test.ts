import { describe, expect, it } from "vitest";
import {
  type PgTestClient,
  type PgTestPool,
  withTestSchema,
  withTestTransaction,
} from "./postgres";

class RecordingClient implements PgTestClient {
  readonly queries: string[] = [];
  releases = 0;

  constructor(private readonly failOn?: string) {}

  async query(text: string): Promise<{ rows: Record<string, unknown>[] }> {
    this.queries.push(text);
    if (text === this.failOn) throw new Error(`query failed: ${text}`);
    return { rows: [] };
  }

  release(): void {
    this.releases += 1;
  }
}

class RecordingPool implements PgTestPool {
  constructor(readonly client: RecordingClient) {}

  async connect(): Promise<PgTestClient> {
    return this.client;
  }
}

describe("withTestTransaction", () => {
  it("always rolls back a successful test transaction and releases its client", async () => {
    const client = new RecordingClient();

    await expect(
      withTestTransaction(new RecordingPool(client), async (transaction) => {
        await transaction.query("INSERT INTO records VALUES (1)");
        return "result";
      })
    ).resolves.toBe("result");
    expect(client.queries).toEqual(["BEGIN", "INSERT INTO records VALUES (1)", "ROLLBACK"]);
    expect(client.releases).toBe(1);
  });

  it("rolls back and preserves a test failure", async () => {
    const client = new RecordingClient();

    await expect(
      withTestTransaction(new RecordingPool(client), async () => {
        throw new Error("assertion failed");
      })
    ).rejects.toThrow("assertion failed");
    expect(client.queries).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.releases).toBe(1);
  });
});

describe("withTestSchema", () => {
  it("isolates a test in a quoted schema and drops it afterward", async () => {
    const client = new RecordingClient();

    await expect(
      withTestSchema(
        new RecordingPool(client),
        "worker_3_case_17",
        async (schemaClient, schema) => {
          expect(schema).toBe("worker_3_case_17");
          await schemaClient.query("SELECT current_schema() AS schema");
          return 17;
        }
      )
    ).resolves.toBe(17);
    expect(client.queries).toEqual([
      'CREATE SCHEMA "worker_3_case_17"',
      'SET search_path TO "worker_3_case_17", public',
      "SELECT current_schema() AS schema",
      "RESET search_path",
      'DROP SCHEMA "worker_3_case_17" CASCADE',
    ]);
    expect(client.releases).toBe(1);
  });

  it("cleans up after failure and rejects unsafe schema names", async () => {
    const client = new RecordingClient();
    const pool = new RecordingPool(client);

    await expect(
      withTestSchema(pool, "safe_case", async () => {
        throw new Error("migration failed");
      })
    ).rejects.toThrow("migration failed");
    expect(client.queries.slice(-2)).toEqual([
      "RESET search_path",
      'DROP SCHEMA "safe_case" CASCADE',
    ]);
    await expect(
      withTestSchema(pool, 'unsafe"; DROP SCHEMA public; --', async () => null)
    ).rejects.toThrow("safe PostgreSQL identifier");
  });

  it("supports concurrent CI workers with distinct schemas", async () => {
    const clients = [new RecordingClient(), new RecordingClient()];

    await Promise.all(
      clients.map((client, index) =>
        withTestSchema(new RecordingPool(client), `worker_${index}`, async () => index)
      )
    );

    expect(clients[0].queries[0]).toBe('CREATE SCHEMA "worker_0"');
    expect(clients[1].queries[0]).toBe('CREATE SCHEMA "worker_1"');
  });
});
