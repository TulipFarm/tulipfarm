import {
  createRecord,
  deleteRecord,
  type ResourceCatalog,
  type ResourceWritePorts,
  updateRecord,
} from "@tulipfarm/resources";
import { RESOURCE_SIDE_EFFECT_STORAGE_STATEMENTS } from "@tulipfarm/storage";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConnectableQueryable, Queryable, ReleasableQueryable } from "../db";
import { PgResourceRepo, PgResourceRepoFactory } from "./repo";
import { createHistoryTableSql, createResourceTableSql } from "./schema";
import { ResourceSchemaCompatibilityService } from "./schema-compatibility";

const CUSTOMER_TYPE = "atomic-customer";
const TICKET_TYPE = "atomic-ticket";
const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const TICKET_ID = "22222222-2222-4222-8222-222222222222";
const NEW_TICKET_ID = "33333333-3333-4333-8333-333333333333";
const databaseUrl = process.env.RESOURCE_ATOMIC_TEST_DATABASE_URL;

const customer = {
  schema: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  },
};
const ticket = {
  schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      customerId: {
        type: "string",
        "x-links": { target: CUSTOMER_TYPE, onDelete: "restrict" },
      },
    },
    required: ["title"],
  },
};
const catalogDefinitions = new Map([
  [CUSTOMER_TYPE, customer],
  [TICKET_TYPE, ticket],
]);
const catalog: ResourceCatalog = catalogDefinitions;

class Deferred {
  readonly promise: Promise<void>;
  private resolvePromise: (() => void) | undefined;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  resolve(): void {
    this.resolvePromise?.();
  }
}

interface Interleaving {
  readonly writerValidated: Deferred;
  readonly allowWriterMutation: Deferred;
  readonly deletionUpdated: Deferred;
  readonly allowDeletionCommit: Deferred;
}

function wrapClient(
  client: PoolClient,
  intercept: (text: string, params: readonly unknown[] | undefined) => Promise<void>
): ReleasableQueryable {
  return {
    query: async <Row>(text: string, params?: readonly unknown[]) => {
      await intercept(text, params);
      return client.query(text, params as unknown[]) as unknown as Promise<{ rows: Row[] }>;
    },
    release: () => client.release(),
  };
}

function interceptPool(
  pool: Pool,
  intercept: (text: string, params: readonly unknown[] | undefined) => Promise<void>
): ConnectableQueryable {
  return {
    query: async <Row>(text: string, params?: readonly unknown[]) => {
      await intercept(text, params);
      return pool.query(text, params as unknown[]) as unknown as Promise<{ rows: Row[] }>;
    },
    connect: async () => wrapClient(await pool.connect(), intercept),
  };
}

function makePorts(database: Queryable): ResourceWritePorts {
  return {
    catalog,
    repositories: new PgResourceRepoFactory(database),
    counter: async () => 1,
    newRecordId: () => NEW_TICKET_ID,
    now: () => new Date("2026-09-17T10:00:00.000Z"),
  };
}

function writerDatabase(pool: Pool, interleaving: Interleaving): ConnectableQueryable {
  let paused = false;
  return interceptPool(pool, async (text, params) => {
    if (
      !paused &&
      ((text.startsWith(`LOCK TABLE resources."${TICKET_TYPE}"`) &&
        text.includes("SHARE ROW EXCLUSIVE")) ||
        (text.includes(`FROM resources."${CUSTOMER_TYPE}" WHERE id = $1`) &&
          params?.[0] === CUSTOMER_ID))
    ) {
      paused = true;
      interleaving.writerValidated.resolve();
      await interleaving.allowWriterMutation.promise;
    }
  });
}

function deletionDatabase(pool: Pool, interleaving: Interleaving): ConnectableQueryable {
  return interceptPool(pool, async (text, params) => {
    if (text.startsWith(`UPDATE resources."${CUSTOMER_TYPE}"`) && params?.[5] === CUSTOMER_ID) {
      interleaving.deletionUpdated.resolve();
      await interleaving.allowDeletionCommit.promise;
    }
  });
}

async function runDeletionRace(
  pool: Pool,
  startWriter: (ports: ResourceWritePorts) => Promise<{ ok: boolean }>
): Promise<void> {
  const interleaving: Interleaving = {
    writerValidated: new Deferred(),
    allowWriterMutation: new Deferred(),
    deletionUpdated: new Deferred(),
    allowDeletionCommit: new Deferred(),
  };
  const writer = startWriter(makePorts(writerDatabase(pool, interleaving)));
  await interleaving.writerValidated.promise;

  const deletion = deleteRecord(
    {
      type: CUSTOMER_TYPE,
      resource: customer,
      id: CUSTOMER_ID,
      expectedVersion: 1,
    },
    makePorts(deletionDatabase(pool, interleaving))
  );
  await interleaving.deletionUpdated.promise;

  let writerSettled = false;
  void writer.finally(() => {
    writerSettled = true;
  });
  interleaving.allowWriterMutation.resolve();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(writerSettled).toBe(false);

  interleaving.allowDeletionCommit.resolve();
  const [deleteResult, writeResult] = await Promise.all([deletion, writer]);
  expect(deleteResult.ok).toBe(true);
  expect(writeResult.ok).toBe(false);

  const customerAfter = await new PgResourceRepo(pool, CUSTOMER_TYPE).findById(CUSTOMER_ID);
  expect(customerAfter?.deletedAt).toBeInstanceOf(Date);
}

describe.skipIf(databaseUrl === undefined)("dependency write atomicity in PostgreSQL", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });

  beforeAll(async () => {
    await pool.query("CREATE SCHEMA IF NOT EXISTS resources");
    for (const type of [CUSTOMER_TYPE, TICKET_TYPE]) {
      await pool.query(createResourceTableSql(type));
      await pool.query(createHistoryTableSql(type));
    }
    for (const statement of RESOURCE_SIDE_EFFECT_STORAGE_STATEMENTS) {
      await pool.query(statement);
    }
  });

  beforeEach(async () => {
    catalogDefinitions.set(TICKET_TYPE, ticket);
    await pool.query(
      `TRUNCATE resources."${CUSTOMER_TYPE}", resources."${CUSTOMER_TYPE}_history",
        resources."${TICKET_TYPE}", resources."${TICKET_TYPE}_history"`
    );
    await pool.query(
      "DELETE FROM resource_side_effect_outbox WHERE effect->>'resourceType' = ANY($1::text[])",
      [[CUSTOMER_TYPE, TICKET_TYPE]]
    );
    const now = new Date("2026-09-17T09:59:00.000Z");
    await new PgResourceRepo(pool, CUSTOMER_TYPE).insert({
      _id: CUSTOMER_ID,
      version: 1,
      createdAt: now,
      updatedAt: now,
      title: "Customer",
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("rejects a create whose linked target is deleted after initial validation", async () => {
    await runDeletionRace(pool, (ports) =>
      createRecord(
        {
          type: TICKET_TYPE,
          resource: ticket,
          data: { title: "New ticket", customerId: CUSTOMER_ID },
        },
        ports
      )
    );

    expect(await new PgResourceRepo(pool, TICKET_TYPE).findById(NEW_TICKET_ID)).toBeNull();
  });

  it("rejects an update whose linked target is deleted after initial validation", async () => {
    const now = new Date("2026-09-17T09:59:00.000Z");
    await new PgResourceRepo(pool, TICKET_TYPE).insert({
      _id: TICKET_ID,
      version: 1,
      createdAt: now,
      updatedAt: now,
      title: "Existing ticket",
    });

    await runDeletionRace(pool, (ports) =>
      updateRecord(
        {
          type: TICKET_TYPE,
          resource: ticket,
          id: TICKET_ID,
          expectedVersion: 1,
          data: { title: "Existing ticket", customerId: CUSTOMER_ID },
          mode: "replace",
        },
        ports
      )
    );

    const ticketAfter = await new PgResourceRepo(pool, TICKET_TYPE).findById(TICKET_ID);
    expect(ticketAfter).toMatchObject({ version: 1, title: "Existing ticket" });
    expect(ticketAfter?.customerId).toBeUndefined();
  });

  it("validates against a Resource definition published while a writer waits", async () => {
    const publicationEntered = new Deferred();
    const allowPublicationCommit = new Deferred();
    const requiredPriority = {
      schema: {
        ...ticket.schema,
        required: ["title", "priority"],
        properties: {
          ...ticket.schema.properties,
          priority: { type: "string" },
        },
      },
    };
    const compatibility = new ResourceSchemaCompatibilityService(pool);
    const publication = compatibility.publishIfCompatible(
      TICKET_TYPE,
      requiredPriority.schema,
      async () => {
        catalogDefinitions.set(TICKET_TYPE, requiredPriority);
        publicationEntered.resolve();
        await allowPublicationCommit.promise;
      }
    );
    await publicationEntered.promise;

    const writer = createRecord(
      {
        type: TICKET_TYPE,
        resource: ticket,
        data: { title: "Stale schema draft" },
      },
      makePorts(pool)
    );
    let writerSettled = false;
    void writer.finally(() => {
      writerSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(writerSettled).toBe(false);

    allowPublicationCommit.resolve();
    await expect(publication).resolves.toMatchObject({ ok: true });
    await expect(writer).resolves.toMatchObject({
      ok: false,
      err: { code: 422, body: { path: "/priority" } },
    });
    expect(await new PgResourceRepo(pool, TICKET_TYPE).findById(NEW_TICKET_ID)).toBeNull();
  });
});
