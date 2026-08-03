import { randomBytes } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { decryptSecret, type SecretEnvelope } from "@tulipfarm/secrets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "../db";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgRawPayloadVault } from "./raw-payload-vault";

describe("PgRawPayloadVault", () => {
  let db: PGlite;
  let dekKey: Buffer;
  let vault: PgRawPayloadVault;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db as unknown as Queryable);
    dekKey = randomBytes(32);
    vault = new PgRawPayloadVault(db as unknown as Queryable, dekKey);
  });

  afterEach(async () => {
    await db.close();
  });

  it("stores the raw delivery bytes encrypted, round-tripping through decryptSecret", async () => {
    const rawBody = Buffer.from(JSON.stringify({ event: "push", ref: "refs/heads/main" }));

    const { artifactId } = await vault.store({
      businessId: "business-1",
      provider: "github",
      triggerSlug: "github-push",
      rawBody,
      receivedAt: "2026-08-03T00:00:00.000Z",
    });

    const rows = await db.query<{
      business_id: string;
      provider: string;
      trigger_slug: string;
      encrypted_body: string;
      iv: string;
      auth_tag: string;
      received_at: string;
    }>("SELECT * FROM webhook_raw_payloads WHERE id = $1", [artifactId]);

    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0];
    expect(row?.business_id).toBe("business-1");
    expect(row?.provider).toBe("github");
    expect(row?.trigger_slug).toBe("github-push");

    const envelope: SecretEnvelope = {
      encryptedValue: row?.encrypted_body ?? "",
      iv: row?.iv ?? "",
      authTag: row?.auth_tag ?? "",
    };
    const decrypted = decryptSecret(envelope, { current: dekKey });
    expect(Buffer.from(decrypted, "base64")).toEqual(rawBody);
  });

  it("stores distinct rows for redelivered payloads", async () => {
    const rawBody = Buffer.from("payload");
    const first = await vault.store({
      businessId: "business-1",
      provider: "github",
      triggerSlug: "github-push",
      rawBody,
      receivedAt: "2026-08-03T00:00:00.000Z",
    });
    const second = await vault.store({
      businessId: "business-1",
      provider: "github",
      triggerSlug: "github-push",
      rawBody,
      receivedAt: "2026-08-03T00:00:01.000Z",
    });

    expect(first.artifactId).not.toBe(second.artifactId);
    const rows = await db.query<{ count: string }>(
      "SELECT count(*)::int AS count FROM webhook_raw_payloads"
    );
    expect(rows.rows[0]?.count).toBe(2);
  });
});
