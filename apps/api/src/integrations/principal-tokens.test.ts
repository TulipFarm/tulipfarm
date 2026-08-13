import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import {
  InMemoryPrincipalProviderTokenRepo,
  PgPrincipalProviderTokenRepo,
  type PrincipalProviderTokenDoc,
  principalSecretKey,
} from "./principal-tokens";

const HUMAN = { kind: "user", id: "u1" };

function doc(overrides: Partial<PrincipalProviderTokenDoc> = {}): PrincipalProviderTokenDoc {
  return {
    principalKind: HUMAN.kind,
    principalId: HUMAN.id,
    provider: "github",
    secretKey: principalSecretKey(HUMAN, "github", "TOKEN"),
    refreshSecretKey: null,
    externalSubject: "gh-4242",
    scopes: ["repo"],
    connectedAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe("principalSecretKey", () => {
  it("scopes a secret to one principal, provider and env name", () => {
    expect(principalSecretKey(HUMAN, "github", "TOKEN")).toBe("principal.user.u1.github.TOKEN");
  });

  it("gives two people distinct keys for the same provider", () => {
    expect(principalSecretKey(HUMAN, "github", "TOKEN")).not.toBe(
      principalSecretKey({ kind: "user", id: "u2" }, "github", "TOKEN")
    );
  });
});

describe("PgPrincipalProviderTokenRepo", () => {
  let db: PGlite;
  let repo: PgPrincipalProviderTokenRepo;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    repo = new PgPrincipalProviderTokenRepo(db, "biz-1");
  });

  it("stores only the secrets-store key, never credential material", async () => {
    await repo.upsert(doc());
    // A database dump without the encryption key must be inert. Asserting on the *column set* is
    // what keeps a later migration from quietly adding somewhere convenient to park a token.
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'principal_provider_tokens' ORDER BY column_name`
    );
    const columns = rows.map((r) => r.column_name);
    expect(columns).toContain("secret_key");
    expect(columns.filter((c) => /token|secret/.test(c)).sort()).toEqual([
      "refresh_secret_key",
      "secret_key",
    ]);
  });

  it("round-trips a connection", async () => {
    await repo.upsert(doc());
    const found = await repo.find(HUMAN, "github");
    expect(found?.secretKey).toBe("principal.user.u1.github.TOKEN");
    expect(found?.externalSubject).toBe("gh-4242");
    expect(found?.scopes).toEqual(["repo"]);
  });

  it("resolves a revoked connection as absent so revocation takes effect on the next call", async () => {
    await repo.upsert(doc());
    expect(await repo.revoke(HUMAN, "github")).toBe(true);
    expect(await repo.find(HUMAN, "github")).toBeNull();
    expect(await repo.listProviders(HUMAN)).toEqual([]);
  });

  it("does not revoke twice, so a second call reports nothing was withdrawn", async () => {
    await repo.upsert(doc());
    await repo.revoke(HUMAN, "github");
    expect(await repo.revoke(HUMAN, "github")).toBe(false);
  });

  it("restores access on reconnect rather than leaving the revocation in force", async () => {
    await repo.upsert(doc());
    await repo.revoke(HUMAN, "github");
    await repo.upsert(doc({ secretKey: "principal.user.u1.github.TOKEN2" }));
    const found = await repo.find(HUMAN, "github");
    expect(found?.secretKey).toBe("principal.user.u1.github.TOKEN2");
    expect(found?.revokedAt).toBeNull();
  });

  it("keeps one person's connection out of another's lookup", async () => {
    await repo.upsert(doc());
    expect(await repo.find({ kind: "user", id: "u2" }, "github")).toBeNull();
    expect(await repo.listProviders({ kind: "user", id: "u2" })).toEqual([]);
  });

  it("keeps one deployment's connection out of another's lookup", async () => {
    await repo.upsert(doc());
    const other = new PgPrincipalProviderTokenRepo(db, "biz-2");
    expect(await other.find(HUMAN, "github")).toBeNull();
  });

  it("lists only the providers a principal currently holds", async () => {
    await repo.upsert(doc());
    await repo.upsert(doc({ provider: "notion" }));
    await repo.upsert(doc({ provider: "slack" }));
    await repo.revoke(HUMAN, "notion");
    expect(await repo.listProviders(HUMAN)).toEqual(["github", "slack"]);
  });

  /**
   * Nothing in the platform refreshes a principal token — there is no path from
   * `refresh_secret_key` back to the provider today — so a lapsed expiry is a dead credential, not
   * a stale one. It must read as *not connected*, because that is what turns the outcome into an
   * actionable "connect your GitHub" prompt instead of an opaque provider 401 raised mid-call,
   * after the gate has already allowed the effect and the model has already committed to the plan.
   */
  it("does not resolve a token whose expiry has passed", async () => {
    await repo.upsert(doc({ expiresAt: new Date(Date.now() - 60_000) }));
    expect(await repo.find(HUMAN, "github")).toBeNull();
  });

  it("still resolves a token that expires in the future", async () => {
    await repo.upsert(doc({ expiresAt: new Date(Date.now() + 3_600_000) }));
    expect(await repo.find(HUMAN, "github")).not.toBeNull();
  });

  /**
   * `listProviders` is what the Settings page reads to say "connected". Showing a provider the
   * resolver will refuse is the same dead end by a different door.
   */
  it("omits an expired provider from the connected list", async () => {
    await repo.upsert(doc({ expiresAt: new Date(Date.now() - 60_000) }));
    expect(await repo.listProviders(HUMAN)).toEqual([]);
  });
});

describe("InMemoryPrincipalProviderTokenRepo", () => {
  /**
   * The double is only useful while it answers "is this a credential?" exactly as the SQL does.
   * A double that resolves what production refuses lets every test above it prove a property the
   * deployment does not have.
   */
  it("matches the Pg repo on expiry and revocation", async () => {
    const mem = new InMemoryPrincipalProviderTokenRepo();
    await mem.upsert(doc({ expiresAt: new Date(Date.now() - 60_000) }));
    expect(await mem.find(HUMAN, "github")).toBeNull();
    expect(await mem.listProviders(HUMAN)).toEqual([]);

    await mem.upsert(doc({ expiresAt: new Date(Date.now() + 3_600_000) }));
    expect(await mem.find(HUMAN, "github")).not.toBeNull();
    expect(await mem.listProviders(HUMAN)).toEqual(["github"]);
  });
});

describe("migration 51", () => {
  it("teaches the auth broker's one-use request whose connect it was", async () => {
    const db = await makePglite();
    await runPgMigrations(db);
    const { rows } = await db.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'integration_auth_requests'
          AND column_name IN ('principal_kind', 'principal_id')
        ORDER BY column_name`
    );
    // Nullable by design: null is the business-wide flow, which is every row written before
    // per-user connect existed and still the default for an operator connecting the deployment.
    expect(rows).toEqual([
      { column_name: "principal_id", is_nullable: "YES" },
      { column_name: "principal_kind", is_nullable: "YES" },
    ]);
  });
});
