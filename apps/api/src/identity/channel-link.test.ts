import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_BIND_SIGNING_KEY,
  CHANNEL_BIND_TTL_MS,
  ChannelBindDeniedError,
  type ChannelBindDeps,
  channelBindKeyResolver,
  issueChannelBindToken,
  parseChannelBindToken,
  previewChannelBind,
  redeemChannelBindToken,
  resolveChannelBindKey,
} from "./channel-link";
import { MemoryExternalIdentityRepo } from "./fakes";

const KEY = Buffer.alloc(32, 9);
const START = new Date("2026-01-01T00:00:00.000Z");

function deps(): ChannelBindDeps & {
  repo: MemoryExternalIdentityRepo;
  clock: { now: Date };
} {
  const repo = new MemoryExternalIdentityRepo();
  const clock = { now: START };
  // The repo's expiry filter stands in for Postgres `now()` — it has to move with the test clock.
  repo.now = () => clock.now;
  return { repo, clock, signingKey: async () => KEY, now: () => clock.now };
}

function memorySecrets(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    list: vi.fn(async () => [...values.keys()].map((key) => ({ key }))),
    get: vi.fn(async (key: string) => {
      const value = values.get(key);
      if (value === undefined) throw new Error(`secret not found: ${key}`);
      return value;
    }),
    set: vi.fn(async (key: string, plaintext: string) => {
      values.set(key, plaintext);
    }),
  };
}

describe("resolveChannelBindKey", () => {
  it("provisions a key on first use so a fresh deployment needs no operator step", async () => {
    const secrets = memorySecrets();

    const key = await resolveChannelBindKey(secrets);

    expect(key).toHaveLength(32);
    expect(secrets.values.has(CHANNEL_BIND_SIGNING_KEY)).toBe(true);
  });

  it("reuses the stored key, so links issued before a restart still verify after it", async () => {
    const secrets = memorySecrets();
    const first = await resolveChannelBindKey(secrets);

    const second = await resolveChannelBindKey(secrets);

    expect(second.equals(first)).toBe(true);
    expect(secrets.set).toHaveBeenCalledTimes(1);
  });

  it("propagates an unreachable store instead of minting a second key over it", async () => {
    // Treating "cannot read" as "does not exist" would invalidate every link already in flight.
    const secrets = memorySecrets();
    secrets.list.mockRejectedValueOnce(new Error("connection refused"));

    await expect(resolveChannelBindKey(secrets)).rejects.toThrow("connection refused");
    expect(secrets.set).not.toHaveBeenCalled();
  });

  it("resolves the key once per process", async () => {
    const secrets = memorySecrets();
    const resolve = channelBindKeyResolver(secrets);

    await Promise.all([resolve(), resolve(), resolve()]);

    expect(secrets.list).toHaveBeenCalledTimes(1);
  });
});

describe("channel bind tokens", () => {
  it("names the sender it was issued for, and nobody else", async () => {
    // No user id in the claims: at issue time no account is known, which is why a link is needed.
    const d = deps();
    const { token, expiresAt } = await issueChannelBindToken(d, {
      slug: "chatapp",
      senderId: "EXT1",
    });

    expect(parseChannelBindToken(KEY, token)).toMatchObject({
      slug: "chatapp",
      senderId: "EXT1",
      issuedAt: START.getTime(),
    });
    expect(expiresAt.getTime()).toBe(START.getTime() + CHANNEL_BIND_TTL_MS);
    expect(JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString())).not.toHaveProperty(
      "userId"
    );
  });

  it("rejects a token whose claims were rewritten, so a sender cannot bind someone else", async () => {
    const d = deps();
    const { token } = await issueChannelBindToken(d, { slug: "chatapp", senderId: "EXT1" });
    const claims = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
    const forged = `${Buffer.from(JSON.stringify({ ...claims, senderId: "VICTIM" })).toString(
      "base64url"
    )}.${token.split(".")[1]}`;

    expect(parseChannelBindToken(KEY, forged)).toBeNull();
    await expect(previewChannelBind(d, forged)).rejects.toBeInstanceOf(ChannelBindDeniedError);
  });

  it("rejects a token signed by another deployment", async () => {
    const d = deps();
    const { token } = await issueChannelBindToken(
      { ...d, signingKey: async () => Buffer.alloc(32, 1) },
      { slug: "chatapp", senderId: "EXT1" }
    );

    await expect(previewChannelBind(d, token)).rejects.toBeInstanceOf(ChannelBindDeniedError);
  });

  it("describes the binding without spending it, so the page shown is the page confirmed", async () => {
    const d = deps();
    const { token } = await issueChannelBindToken(d, { slug: "chatapp", senderId: "EXT1" });

    const offer = await previewChannelBind(d, token);
    expect(offer).toMatchObject({ slug: "chatapp", senderId: "EXT1" });

    // Still redeemable: previewing is a read.
    await expect(redeemChannelBindToken(d, token, "u1")).resolves.toMatchObject({ userId: "u1" });
  });

  it("binds the sender to the confirming account, recording how it was verified", async () => {
    const d = deps();
    const { token } = await issueChannelBindToken(d, { slug: "chatapp", senderId: "EXT1" });

    await redeemChannelBindToken(d, token, "u1");

    expect(await d.repo.findMapping("chatapp", "EXT1")).toMatchObject({
      userId: "u1",
      verifiedVia: "bind_link",
    });
  });

  it("refuses a replayed link, so a captured URL cannot re-bind the sender", async () => {
    const d = deps();
    const { token } = await issueChannelBindToken(d, { slug: "chatapp", senderId: "EXT1" });
    await redeemChannelBindToken(d, token, "u1");

    await expect(redeemChannelBindToken(d, token, "attacker")).rejects.toBeInstanceOf(
      ChannelBindDeniedError
    );
    // The first claim stands.
    expect(await d.repo.findMapping("chatapp", "EXT1")).toMatchObject({ userId: "u1" });
  });

  it("refuses an expired link, from the signed claims and from the row alike", async () => {
    const d = deps();
    const { token } = await issueChannelBindToken(d, { slug: "chatapp", senderId: "EXT1" });

    d.clock.now = new Date(START.getTime() + CHANNEL_BIND_TTL_MS);

    await expect(previewChannelBind(d, token)).rejects.toBeInstanceOf(ChannelBindDeniedError);
    await expect(redeemChannelBindToken(d, token, "u1")).rejects.toBeInstanceOf(
      ChannelBindDeniedError
    );
    expect(await d.repo.findMapping("chatapp", "EXT1")).toBeNull();
  });

  it("refuses a well-formed token whose nonce was never issued here", async () => {
    // The signature is the only thing a forger controls if the key ever leaks; the row is not.
    const d = deps();
    const { token } = await issueChannelBindToken(d, { slug: "chatapp", senderId: "EXT1" });
    d.repo.bindTokens.length = 0;

    await expect(previewChannelBind(d, token)).rejects.toBeInstanceOf(ChannelBindDeniedError);
  });

  it("gives one reason for every refusal, telling a holder nothing about why", async () => {
    const d = deps();
    const { token } = await issueChannelBindToken(d, { slug: "chatapp", senderId: "EXT1" });
    await redeemChannelBindToken(d, token, "u1");

    const spent = await redeemChannelBindToken(d, token, "u2").catch((err) => err);
    const forged = await previewChannelBind(d, "not-a-token").catch((err) => err);

    expect(spent.reason).toBe("invalid_token");
    expect(forged.reason).toBe("invalid_token");
  });
});
