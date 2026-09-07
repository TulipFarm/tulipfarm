import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { ChannelSurfaceStore, IntegrationStore, transactionPort } from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import {
  type ExternalIdentityMappingDoc,
  type IdentityVerificationMethod,
  PgExternalIdentityRepo,
  PgExternalIdentityUnlinker,
} from "./external-links";

const NOW = new Date("2026-08-18T12:00:00Z");
const USER = "11111111-1111-4111-8111-111111111111";

/**
 * `listProvenMappingsForUser` filters in SQL, and SQL is where the interesting failure lives:
 * `verified_via = ANY(...)` is NULL — not false — for a NULL column, so the row is excluded rather
 * than admitted. Nothing in the type system can show that, so it is exercised against a real
 * database.
 */
describe("PgExternalIdentityRepo knowledge-grade filtering", () => {
  let db: PGlite;
  let repo: PgExternalIdentityRepo;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    await db.query(
      `INSERT INTO users (id, email, password_hash, role, created_at)
       VALUES ($1, 'linker@example.com', 'x', 'member', now())`,
      [USER]
    );
    repo = new PgExternalIdentityRepo(db);
  });

  afterEach(async () => {
    await db.close();
  });

  const mapping = (
    provider: string,
    verifiedVia: IdentityVerificationMethod | null
  ): ExternalIdentityMappingDoc => ({
    provider,
    externalSubject: `subject-${provider}`,
    ...(provider === "slack" ? { externalTenantId: "T1" } : {}),
    userId: USER,
    verifiedAt: NOW,
    expiresAt: null,
    verifiedVia,
  });

  const knowledgeProviders = async (): Promise<string[]> =>
    (await repo.listProvenMappingsForUser(USER)).map((m) => m.provider);

  it.each(["link_token", "bind_link"] as const)("returns a %s mapping", async (method) => {
    await repo.upsertMapping(mapping("slack", method));

    expect(await knowledgeProviders()).toEqual(["slack"]);
  });

  it("omits a manifest_email mapping while still listing it as an identity", async () => {
    await repo.upsertMapping(mapping("slack", "manifest_email"));

    expect(await knowledgeProviders()).toEqual([]);
    expect(await repo.listMappingsForUser(USER)).toHaveLength(1);
  });

  it("omits a NULL-provenance mapping, because ANY() over NULL must not admit the row", async () => {
    await repo.upsertMapping(mapping("slack", null));

    expect(await knowledgeProviders()).toEqual([]);
    expect(await repo.listMappingsForUser(USER)).toHaveLength(1);
  });

  it("returns only the strong rows when a user holds a mix", async () => {
    await repo.upsertMapping(mapping("slack", "link_token"));
    await repo.upsertMapping(mapping("confluence", "manifest_email"));
    await repo.upsertMapping(mapping("google-drive", null));
    await repo.upsertMapping(mapping("github", "bind_link"));

    expect(await knowledgeProviders()).toEqual(["github", "slack"]);
    expect(await repo.listMappingsForUser(USER)).toHaveLength(4);
  });

  it("does not leak another user's strong mapping", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    await db.query(
      `INSERT INTO users (id, email, password_hash, role, created_at)
       VALUES ($1, 'other@example.com', 'x', 'member', now())`,
      [other]
    );
    await repo.upsertMapping({ ...mapping("slack", "link_token"), userId: other });

    expect(await knowledgeProviders()).toEqual([]);
  });

  it("stops returning a mapping once it is revoked", async () => {
    await repo.upsertMapping(mapping("slack", "link_token"));
    expect(await knowledgeProviders()).toEqual(["slack"]);

    await repo.deleteMapping("slack", "subject-slack", "T1");

    expect(await knowledgeProviders()).toEqual([]);
  });

  it("drops the grant when a mapping is downgraded to manifest_email in place", async () => {
    await repo.upsertMapping(mapping("slack", "link_token"));
    expect(await knowledgeProviders()).toEqual(["slack"]);

    await repo.upsertMapping(mapping("slack", "manifest_email"));

    expect(await knowledgeProviders()).toEqual([]);
  });

  it("keeps the same Slack subject isolated across workspaces", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    await db.query(
      `INSERT INTO users (id, email, password_hash, role, created_at)
       VALUES ($1, 'other@example.com', 'x', 'member', now())`,
      [other]
    );
    await repo.upsertMapping({
      ...mapping("slack", "bind_link"),
      externalSubject: "U-SHARED",
      externalTenantId: "T1",
    });
    await repo.upsertMapping({
      ...mapping("slack", "bind_link"),
      externalSubject: "U-SHARED",
      externalTenantId: "T2",
      userId: other,
    });

    await expect(repo.findMapping("slack", "U-SHARED", "T1")).resolves.toMatchObject({
      userId: USER,
    });
    await expect(repo.findMapping("slack", "U-SHARED", "T2")).resolves.toMatchObject({
      userId: other,
    });
    await expect(repo.findMapping("slack", "U-SHARED")).resolves.toBeNull();
  });

  it("atomically enqueues an exact Slack Home replacement when unlinking", async () => {
    const transactions = transactionPort(db);
    const integrations = new IntegrationStore(transactions);
    const surfaces = new ChannelSurfaceStore(transactions, () => NOW.toISOString());
    await integrations.putApp({
      id: "slack-app",
      businessId: DEPLOYMENT_BUSINESS_ID,
      provider: "slack",
      externalAppId: "A1",
      credentialRefs: ["secret://slack/bot"],
      status: "active",
    });
    await integrations.putIntegration({
      id: "slack-workspace",
      businessId: DEPLOYMENT_BUSINESS_ID,
      appId: "slack-app",
      externalTenantId: "T1",
      credentialRef: "secret://slack/bot",
      status: "active",
    });
    const linked = mapping("slack", "link_token");
    await repo.upsertMapping(linked);

    await new PgExternalIdentityUnlinker(db, DEPLOYMENT_BUSINESS_ID, () =>
      NOW.toISOString()
    ).unlink(linked);

    await expect(repo.findMapping("slack", "subject-slack", "T1")).resolves.toBeNull();
    await expect(
      surfaces.claimPublish({
        businessId: DEPLOYMENT_BUSINESS_ID,
        owner: "worker-1",
        limit: 10,
        leaseDurationMs: 30_000,
      })
    ).resolves.toEqual([
      expect.objectContaining({
        businessId: DEPLOYMENT_BUSINESS_ID,
        integrationId: "slack-workspace",
        externalTenantId: "T1",
        externalSubject: "subject-slack",
        surface: "home",
      }),
    ]);
  });

  it("rolls back a Slack unlink when the replacement cannot be enqueued", async () => {
    const transactions = transactionPort(db);
    const integrations = new IntegrationStore(transactions);
    const surfaces = new ChannelSurfaceStore(transactions, () => NOW.toISOString());
    await integrations.putApp({
      id: "slack-app",
      businessId: DEPLOYMENT_BUSINESS_ID,
      provider: "slack",
      externalAppId: "A1",
      credentialRefs: ["secret://slack/bot"],
      status: "active",
    });
    await integrations.putIntegration({
      id: "slack-workspace",
      businessId: DEPLOYMENT_BUSINESS_ID,
      appId: "slack-app",
      externalTenantId: "T1",
      credentialRef: "secret://slack/bot",
      status: "active",
    });
    const linked = mapping("slack", "link_token");
    await repo.upsertMapping(linked);
    await surfaces.upsertInstance({
      businessId: DEPLOYMENT_BUSINESS_ID,
      provider: "slack",
      integrationId: "slack-workspace",
      externalTenantId: "T1",
      externalSubject: "subject-slack",
      surface: "home",
      externalId: "home",
      renderDigest: "old-authorized-home",
      status: "revoked",
    });

    await expect(
      new PgExternalIdentityUnlinker(db, DEPLOYMENT_BUSINESS_ID, () => NOW.toISOString()).unlink(
        linked
      )
    ).rejects.toThrow("channel_surface_instance_not_publishable");

    await expect(repo.findMapping("slack", "subject-slack", "T1")).resolves.toMatchObject({
      userId: USER,
    });
  });

  it("deletes a Slack mapping when its Integration is revoked without enqueueing", async () => {
    const transactions = transactionPort(db);
    const integrations = new IntegrationStore(transactions);
    const surfaces = new ChannelSurfaceStore(transactions, () => NOW.toISOString());
    await integrations.putApp({
      id: "slack-app",
      businessId: DEPLOYMENT_BUSINESS_ID,
      provider: "slack",
      externalAppId: "A1",
      credentialRefs: ["secret://slack/bot"],
      status: "active",
    });
    await integrations.putIntegration({
      id: "slack-workspace",
      businessId: DEPLOYMENT_BUSINESS_ID,
      appId: "slack-app",
      externalTenantId: "T1",
      credentialRef: "secret://slack/bot",
      status: "revoked",
    });
    const linked = mapping("slack", "link_token");
    await repo.upsertMapping(linked);

    await new PgExternalIdentityUnlinker(db, DEPLOYMENT_BUSINESS_ID, () =>
      NOW.toISOString()
    ).unlink(linked);

    await expect(repo.findMapping("slack", "subject-slack", "T1")).resolves.toBeNull();
    await expect(
      surfaces.claimPublish({
        businessId: DEPLOYMENT_BUSINESS_ID,
        owner: "worker-1",
        limit: 10,
        leaseDurationMs: 30_000,
      })
    ).resolves.toEqual([]);
  });

  it("keeps non-Slack unlink behavior independent of App Home", async () => {
    const linked = mapping("github", "link_token");
    await repo.upsertMapping(linked);

    await new PgExternalIdentityUnlinker(db, DEPLOYMENT_BUSINESS_ID, () =>
      NOW.toISOString()
    ).unlink(linked);

    await expect(repo.findMapping("github", "subject-github")).resolves.toBeNull();
  });
});
