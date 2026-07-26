import {
  AdapterDispatchError,
  type ToolAdapterRequest,
  type ToolIntent,
} from "@tulipfarm/tool-broker";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PostgresAdapter,
  type PostgresAdapterContext,
  type PostgresIdempotencyPort,
  type PostgresIntegrationSession,
  type PostgresQueryResult,
  PostgresTransactionError,
} from "./adapter";
import { POSTGRES_TOOL_IDS } from "./contracts";

const CREDENTIAL = "postgresql://leased-credential";

function intent(action: string, args: unknown, idempotencyKey = "effect-1"): ToolIntent {
  return {
    intentId: "intent-1",
    businessId: "business-1",
    runId: "run-1",
    stateId: "state-1",
    toolId: action,
    toolVersion: "1.0.0",
    action,
    targetRefs: [{ type: "postgres.table", id: "public.invoices" }],
    arguments: args,
    destination: "postgres:accounting",
    credentialRef: "secret://postgres/accounting",
    idempotencyKey,
  };
}

function request(toolIntent: ToolIntent): ToolAdapterRequest {
  return { intent: toolIntent, idempotencyKey: toolIntent.idempotencyKey, attempt: 1 };
}

function context(): PostgresAdapterContext {
  return {
    integrationId: "integration-1",
    grant: {
      integrationId: "integration-1",
      schema: "public",
      table: "invoices",
      actions: ["read", "insert", "update", "delete"],
      columns: ["id", "tenant_id", "amount", "status"],
      rowScope: { column: "tenant_id", value: "tenant-1" },
      maximumRows: 2,
    },
  };
}

class FakeSession implements PostgresIntegrationSession {
  readonly calls: Array<{ text: string; params: readonly unknown[] }> = [];
  rows: Record<string, unknown>[] = [];
  transactionError?: Error;

  async query(text: string, params: readonly unknown[] = []) {
    this.calls.push({ text, params });
    return { rows: this.rows, rowCount: this.rows.length };
  }

  async withTransaction<T>(
    callback: (transaction: PostgresIntegrationSession) => Promise<T>
  ): Promise<T> {
    if (this.transactionError !== undefined) throw this.transactionError;
    return callback(this);
  }
}

function beginMock() {
  return vi.fn(
    async (
      _session: PostgresIntegrationSession,
      _idempotencyKey: string
    ): ReturnType<PostgresIdempotencyPort["begin"]> => ({ outcome: "started" })
  );
}

function completeMock() {
  return vi.fn(
    async (
      _session: PostgresIntegrationSession,
      _idempotencyKey: string,
      result: PostgresQueryResult
    ): ReturnType<PostgresIdempotencyPort["complete"]> => result
  );
}

let session: FakeSession;
let resolved: PostgresAdapterContext | undefined;
let begin: ReturnType<typeof beginMock>;
let complete: ReturnType<typeof completeMock>;
let adapter: PostgresAdapter;

beforeEach(() => {
  session = new FakeSession();
  resolved = context();
  begin = beginMock();
  complete = completeMock();
  adapter = new PostgresAdapter({
    context: { resolve: async () => resolved },
    connection: {
      withCredential: async (credential, callback) => {
        if (credential !== CREDENTIAL) throw new Error("unleased Credential");
        return callback(session);
      },
    },
    idempotency: { begin, complete },
    timeoutMs: 500,
  });
});

describe("PostgresAdapter reads", () => {
  it("builds identifiers itself and parameterizes values including injection-shaped input", async () => {
    session.rows = [{ id: "inv-1", tenant_id: "tenant-1", amount: 42, secret: "strip-me" }];
    const injection = "inv-1'; DROP TABLE invoices; --";

    const result = await adapter.dispatch(
      request(
        intent(POSTGRES_TOOL_IDS.read, {
          schema: "public",
          table: "invoices",
          columns: ["id", "amount"],
          where: [{ column: "id", equals: injection }],
          limit: 1,
        })
      ),
      CREDENTIAL
    );

    const query = session.calls.find((call) => call.text.startsWith('SELECT "'));
    expect(query?.text).toBe(
      'SELECT "id", "amount" FROM "public"."invoices" ' +
        'WHERE "tenant_id" = $1 AND "id" = $2 LIMIT $3'
    );
    expect(query?.text).not.toContain(injection);
    expect(query?.params).toEqual(["tenant-1", injection, 1]);
    expect(result).toEqual({ rows: [{ id: "inv-1", amount: 42 }], rowCount: 1 });
  });

  it("rejects multi-statement identifiers, unauthorized fields, and conflicting row scope", async () => {
    for (const argumentsValue of [
      {
        schema: "public",
        table: "invoices; DROP TABLE users",
        columns: ["id"],
        limit: 1,
      },
      { schema: "public", table: "invoices", columns: ["secret"], limit: 1 },
      {
        schema: "public",
        table: "invoices",
        columns: ["id"],
        where: [{ column: "tenant_id", equals: "tenant-2" }],
        limit: 1,
      },
    ]) {
      await expect(
        adapter.dispatch(request(intent(POSTGRES_TOOL_IDS.read, argumentsValue)), CREDENTIAL)
      ).rejects.toBeInstanceOf(AdapterDispatchError);
    }
    expect(session.calls).toEqual([]);
  });

  it("fails instead of truncating an unexpectedly large result", async () => {
    session.rows = [{ id: "1" }, { id: "2" }, { id: "3" }];

    await expect(
      adapter.dispatch(
        request(
          intent(POSTGRES_TOOL_IDS.read, {
            schema: "public",
            table: "invoices",
            columns: ["id"],
            limit: 2,
          })
        ),
        CREDENTIAL
      )
    ).rejects.toMatchObject({ code: "result_limit_exceeded", phase: "after_dispatch" });
  });
});

describe("PostgresAdapter mutations", () => {
  it("runs a parameterized mutation and idempotency evidence in one transaction", async () => {
    session.rows = [{ id: "inv-1", status: "paid" }];

    const result = await adapter.dispatch(
      request(
        intent(POSTGRES_TOOL_IDS.mutate, {
          operation: "update",
          schema: "public",
          table: "invoices",
          values: { status: "paid" },
          where: [{ column: "id", equals: "inv-1" }],
          returning: ["id", "status"],
        })
      ),
      CREDENTIAL
    );

    expect(begin).toHaveBeenCalledWith(session, "effect-1");
    expect(
      session.calls.find((call) => call.text.startsWith('UPDATE "public"."invoices"'))
    ).toEqual({
      text:
        'UPDATE "public"."invoices" SET "status" = $1 ' +
        'WHERE "tenant_id" = $2 AND "id" = $3 RETURNING "id", "status"',
      params: ["paid", "tenant-1", "inv-1"],
    });
    expect(complete).toHaveBeenCalledWith(session, "effect-1", {
      rows: [{ id: "inv-1", status: "paid" }],
      rowCount: 1,
    });
    expect(result).toEqual({ rows: [{ id: "inv-1", status: "paid" }], rowCount: 1 });
  });

  it("returns a duplicate result without issuing another mutation", async () => {
    begin.mockResolvedValue({
      outcome: "duplicate",
      result: { rows: [{ id: "existing" }], rowCount: 1 },
    });

    await expect(
      adapter.dispatch(
        request(
          intent(POSTGRES_TOOL_IDS.mutate, {
            operation: "delete",
            schema: "public",
            table: "invoices",
            where: [{ column: "id", equals: "inv-1" }],
            returning: ["id"],
          })
        ),
        CREDENTIAL
      )
    ).resolves.toEqual({ rows: [{ id: "existing" }], rowCount: 1 });
    expect(session.calls.some((call) => call.text.startsWith("DELETE "))).toBe(false);
  });

  it("rejects updates that move a row outside the granted row scope", async () => {
    await expect(
      adapter.dispatch(
        request(
          intent(POSTGRES_TOOL_IDS.mutate, {
            operation: "update",
            schema: "public",
            table: "invoices",
            values: { tenant_id: "tenant-2" },
            where: [{ column: "id", equals: "inv-1" }],
            returning: ["id"],
          })
        ),
        CREDENTIAL
      )
    ).rejects.toMatchObject({ code: "row_denied", phase: "before_dispatch" });
    expect(session.calls).toEqual([]);
    expect(begin).not.toHaveBeenCalled();
  });

  it("maps timeouts safely and treats an unknown commit as ambiguous", async () => {
    session.transactionError = new PostgresTransactionError("before_commit", "timeout");
    await expect(
      adapter.dispatch(
        request(
          intent(POSTGRES_TOOL_IDS.read, {
            schema: "public",
            table: "invoices",
            columns: ["id"],
            limit: 1,
          })
        ),
        CREDENTIAL
      )
    ).rejects.toMatchObject({ code: "postgres_timeout", phase: "before_dispatch" });

    session.transactionError = new PostgresTransactionError("commit_unknown", "network");
    await expect(
      adapter.dispatch(
        request(
          intent(POSTGRES_TOOL_IDS.mutate, {
            operation: "delete",
            schema: "public",
            table: "invoices",
            where: [{ column: "id", equals: "inv-1" }],
            returning: ["id"],
          })
        ),
        CREDENTIAL
      )
    ).rejects.toMatchObject({ code: "postgres_commit_ambiguous", phase: "after_dispatch" });
  });
});
