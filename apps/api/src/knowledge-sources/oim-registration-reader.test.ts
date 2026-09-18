import { PGlite } from "@electric-sql/pglite";
import {
  ConnectionStore,
  OIM_KNOWLEDGE_SUBSCRIPTION_STORAGE_STATEMENTS,
  OimKnowledgeSubscriptionStore,
  transactionPort,
} from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import { PgOimKnowledgeRegistrationReader } from "./oim-registration-reader";

describe("PgOimKnowledgeRegistrationReader", () => {
  it("migrates prior scope selection independently of source status and preserves strict ACL ages and classifications", async () => {
    const db = await PGlite.create();
    try {
      await db.exec(`
        CREATE TABLE connections (
          business_id text, id text, integration_id text, integration_major_version integer,
          PRIMARY KEY (business_id, id, integration_id, integration_major_version)
        );
        CREATE TABLE knowledge_source_records (
          business_id text, integration_id text, source_locator jsonb, classification text[],
          access_control_mode text, access_control_max_age_seconds integer, status text
        );
        INSERT INTO connections VALUES ('business', 'connection', 'wiki', 1);
      `);
      for (const [scope, classification, age, status] of [
        ["first", [], 300, "active"],
        ["last-deleted", ["confidential", "internal"], 60, "deleted"],
      ] as const) {
        await db.query(
          "INSERT INTO knowledge_source_records VALUES ($1,$2,$3,$4,'snapshot',$5,$6)",
          [
            "business",
            "wiki",
            {
              kind: "oim",
              integrationSlug: "wiki-install",
              integrationId: "wiki",
              integrationMajorVersion: 1,
              connectionId: "connection",
              sourceKindId: "space",
              scope,
            },
            [...classification],
            age,
            status,
          ]
        );
      }
      for (const statement of OIM_KNOWLEDGE_SUBSCRIPTION_STORAGE_STATEMENTS)
        await db.exec(statement);
      const selected = (await new PgOimKnowledgeRegistrationReader(db).list())[0];
      expect(selected).toMatchObject({
        scopes: ["first", "last-deleted"],
        aclMaximumAgeSeconds: 60,
        classification: expect.arrayContaining(["confidential", "internal"]),
      });
      await db.exec("DELETE FROM knowledge_source_records");
      expect(await new PgOimKnowledgeRegistrationReader(db).list()).toEqual([selected]);
    } finally {
      await db.close();
    }
  });
  it("discovers only enabled durable selections without requiring any emitted source", async () => {
    const db = await makeMigratedPglite();
    try {
      await new ConnectionStore(transactionPort(db)).put("business-1", {
        id: "connection",
        integration: { id: "wiki", majorVersion: 1 },
        label: "Wiki",
        owner: { scope: "organization" },
        status: "active",
        isDefault: false,
        configuration: {},
        agentVisibleConfiguration: [],
        secretBindings: {},
        health: { status: "healthy", checkedAt: new Date().toISOString() },
        expiresAt: null,
      });
      const store = new OimKnowledgeSubscriptionStore(db);
      const subscription = {
        businessId: "business-1",
        integrationSlug: "wiki",
        integrationId: "wiki",
        integrationMajorVersion: 1,
        connectionId: "connection",
        sourceKindId: "space",
        scopes: ["selected"],
        classification: ["confidential"],
        aclMaximumAgeSeconds: 60,
        liveMaximumAgeSeconds: 30,
        enabled: true,
      };
      const reader = new PgOimKnowledgeRegistrationReader(db);
      expect(await reader.list()).toEqual([]);
      const saved = await store.save(subscription);
      expect(await reader.list()).toEqual([expect.objectContaining(subscription)]);
      await store.recordAttempt(saved, [], true, new Date("2026-09-17T12:00:00Z"));
      expect((await store.list("business-1", "connection"))[0]?.lastSuccessAt).toBe(
        "2026-09-17T12:00:00.000Z"
      );
      await store.recordAttempt(saved, ["acl_failed"], false, new Date("2026-09-17T12:01:00Z"));
      expect((await store.list("business-1", "connection"))[0]).toMatchObject({
        lastErrorCodes: ["acl_failed"],
        lastSuccessAt: "2026-09-17T12:00:00.000Z",
      });
      await store.save({ ...subscription, enabled: false });
      await store.recordAttempt(saved, [], true, new Date("2026-09-17T12:02:00Z"));
      expect((await store.list("business-1", "connection"))[0]).toMatchObject({
        lastErrorCodes: ["acl_failed"],
        lastSuccessAt: "2026-09-17T12:00:00.000Z",
      });
      expect(await reader.list()).toEqual([]);
      expect(await store.list("another-business", "connection")).toEqual([]);
      expect((await store.list("business-1", "connection"))[0]).toMatchObject({
        scopes: ["selected"],
        enabled: false,
      });
    } finally {
      await db.close();
    }
  });
});
