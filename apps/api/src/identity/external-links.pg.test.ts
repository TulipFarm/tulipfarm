import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import {
  type ExternalIdentityMappingDoc,
  type IdentityVerificationMethod,
  PgExternalIdentityRepo,
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

    await repo.deleteMapping("slack", "subject-slack");

    expect(await knowledgeProviders()).toEqual([]);
  });

  it("drops the grant when a mapping is downgraded to manifest_email in place", async () => {
    await repo.upsertMapping(mapping("slack", "link_token"));
    expect(await knowledgeProviders()).toEqual(["slack"]);

    await repo.upsertMapping(mapping("slack", "manifest_email"));

    expect(await knowledgeProviders()).toEqual([]);
  });
});
