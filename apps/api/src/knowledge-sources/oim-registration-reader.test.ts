import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { PgOimKnowledgeRegistrationReader } from "./oim-registration-reader";

describe("PgOimKnowledgeRegistrationReader", () => {
  it("rebuilds current registrations from durable OIM source provenance", async () => {
    const database = await PGlite.create();
    await createKnowledgeSources(database);
    await insertKnowledgeSource(database, {
      sourceId: "source-b",
      locator: {
        kind: "oim",
        integrationSlug: "acme-install",
        integrationId: "acme",
        integrationMajorVersion: 2,
        connectionId: "connection-1",
        sourceKindId: "space",
        scope: "space-b",
      },
      classification: ["internal"],
      maximumAgeSeconds: 600,
    });
    await insertKnowledgeSource(database, {
      sourceId: "source-a",
      locator: {
        kind: "oim",
        integrationSlug: "acme-install",
        integrationId: "acme",
        integrationMajorVersion: 2,
        connectionId: "connection-1",
        sourceKindId: "space",
        scope: "space-a",
      },
      classification: ["confidential"],
      maximumAgeSeconds: 300,
    });
    const reader = new PgOimKnowledgeRegistrationReader(database);

    try {
      await expect(reader.list()).resolves.toEqual([
        {
          businessId: "business-1",
          integrationSlug: "acme-install",
          connectionId: "connection-1",
          integrationId: "acme",
          integrationMajorVersion: 2,
          sourceKindId: "space",
          scopes: ["space-a", "space-b"],
          classification: ["confidential", "internal"],
          aclMaximumAgeSeconds: 300,
        },
      ]);
    } finally {
      await database.close();
    }
  });

  it("ignores rows without complete OIM provenance", async () => {
    const database = await PGlite.create();
    await createKnowledgeSources(database);
    await insertKnowledgeSource(database, {
      sourceId: "legacy-source",
      locator: { kind: "legacy" },
      classification: [],
      accessControlMode: "live",
      maximumAgeSeconds: 60,
    });
    const reader = new PgOimKnowledgeRegistrationReader(database);

    try {
      await expect(reader.list()).resolves.toEqual([]);
    } finally {
      await database.close();
    }
  });
});

async function createKnowledgeSources(database: PGlite): Promise<void> {
  await database.exec(`
    CREATE TABLE knowledge_source_records (
      business_id text NOT NULL,
      source_id text NOT NULL,
      integration_id text NOT NULL,
      source_locator jsonb NOT NULL,
      classification text[] NOT NULL,
      access_control_mode text NOT NULL,
      access_control_max_age_seconds integer NOT NULL,
      status text NOT NULL
    )
  `);
}

async function insertKnowledgeSource(
  database: PGlite,
  input: {
    readonly sourceId: string;
    readonly locator: Readonly<Record<string, unknown>>;
    readonly classification: readonly string[];
    readonly accessControlMode?: "snapshot" | "live";
    readonly maximumAgeSeconds: number;
  }
): Promise<void> {
  await database.query(
    `INSERT INTO knowledge_source_records (
       business_id, source_id, integration_id, source_locator, classification,
       access_control_mode, access_control_max_age_seconds, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')`,
    [
      "business-1",
      input.sourceId,
      "acme",
      input.locator,
      input.classification,
      input.accessControlMode ?? "snapshot",
      input.maximumAgeSeconds,
    ]
  );
}
