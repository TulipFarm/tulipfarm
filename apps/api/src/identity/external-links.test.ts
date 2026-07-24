import { describe, expect, it } from "vitest";
import {
  ExternalIdentityDeniedError,
  type ExternalIdentityMappingDoc,
  type ExternalIdentityRepo,
  type ExternalLinkTokenDoc,
  hashLinkToken,
  LinkRedemptionDeniedError,
  mintLinkToken,
  redeemLinkToken,
  resolveExternalIdentity,
} from "./external-links";
import { MemoryExternalIdentityRepo } from "./fakes";

describe("link tokens", () => {
  it("stores only the token hash", async () => {
    const repo = new MemoryExternalIdentityRepo();
    const { raw } = await mintLinkToken(repo, { userId: "u1", provider: "slack" });

    expect(repo.tokens[0].tokenHash).toBe(hashLinkToken(raw));
    expect(JSON.stringify(repo.tokens)).not.toContain(raw);
  });

  it("redeems once, creating the verified mapping", async () => {
    const repo = new MemoryExternalIdentityRepo();
    const { raw } = await mintLinkToken(repo, { userId: "u1", provider: "slack" });

    const mapping = await redeemLinkToken(repo, {
      raw,
      provider: "slack",
      externalSubject: "U123",
    });

    expect(mapping).toMatchObject({ provider: "slack", externalSubject: "U123", userId: "u1" });
    expect(await resolveExternalIdentity(repo, "slack", "U123")).toBe("u1");
  });

  it("denies a replayed link token", async () => {
    const repo = new MemoryExternalIdentityRepo();
    const { raw } = await mintLinkToken(repo, { userId: "u1", provider: "slack" });
    await redeemLinkToken(repo, { raw, provider: "slack", externalSubject: "U123" });

    await expect(
      redeemLinkToken(repo, { raw, provider: "slack", externalSubject: "U-attacker" })
    ).rejects.toMatchObject({ reason: "invalid_token" });
    expect(repo.mappings).toHaveLength(1);
  });

  it("denies concurrent redemptions of the same token beyond the first", async () => {
    const repo = new MemoryExternalIdentityRepo();
    const { raw } = await mintLinkToken(repo, { userId: "u1", provider: "slack" });

    const results = await Promise.allSettled([
      redeemLinkToken(repo, { raw, provider: "slack", externalSubject: "U1" }),
      redeemLinkToken(repo, { raw, provider: "slack", externalSubject: "U2" }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(repo.mappings).toHaveLength(1);
  });

  it("denies an expired link token", async () => {
    const repo = new MemoryExternalIdentityRepo();
    const { raw } = await mintLinkToken(repo, {
      userId: "u1",
      provider: "slack",
      ttlSeconds: -1,
    });

    await expect(
      redeemLinkToken(repo, { raw, provider: "slack", externalSubject: "U123" })
    ).rejects.toBeInstanceOf(LinkRedemptionDeniedError);
  });

  it("denies redemption under a different provider than it was minted for", async () => {
    const repo = new MemoryExternalIdentityRepo();
    const { raw } = await mintLinkToken(repo, { userId: "u1", provider: "slack" });

    await expect(
      redeemLinkToken(repo, { raw, provider: "github", externalSubject: "U123" })
    ).rejects.toMatchObject({ reason: "provider_mismatch" });
    expect(repo.mappings).toHaveLength(0);
  });

  it("denies a forged token", async () => {
    const repo = new MemoryExternalIdentityRepo();
    await mintLinkToken(repo, { userId: "u1", provider: "slack" });

    await expect(
      redeemLinkToken(repo, { raw: "forged", provider: "slack", externalSubject: "U123" })
    ).rejects.toMatchObject({ reason: "invalid_token" });
  });
});

describe("resolveExternalIdentity", () => {
  it("denies an unmapped subject", async () => {
    const repo = new MemoryExternalIdentityRepo();

    await expect(resolveExternalIdentity(repo, "slack", "U404")).rejects.toBeInstanceOf(
      ExternalIdentityDeniedError
    );
  });

  it("denies an expired mapping", async () => {
    const repo = new MemoryExternalIdentityRepo();
    await repo.upsertMapping({
      provider: "slack",
      externalSubject: "U123",
      userId: "u1",
      verifiedAt: new Date(Date.now() - 10_000),
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(resolveExternalIdentity(repo, "slack", "U123")).rejects.toMatchObject({
      reason: "expired",
    });
  });
});
