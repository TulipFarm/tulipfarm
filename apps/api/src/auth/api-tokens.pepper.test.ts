import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PaginatedResult } from "../pagination";
import {
  createApiToken,
  findTokenForRawToken,
  hashToken,
  hashTokenLegacy,
  type TokenDoc,
  type TokenRepo,
} from "./api-tokens";

// A repo that supports the optional lazy re-hash, so we can observe the upgrade.
class MemoryTokenRepo implements TokenRepo {
  tokens: TokenDoc[] = [];
  updateHashCalls = 0;

  async create(token: TokenDoc): Promise<void> {
    this.tokens.push(token);
  }
  async findByHash(hash: string): Promise<TokenDoc | null> {
    return this.tokens.find((t) => t.tokenHash === hash) ?? null;
  }
  async updateHash(id: string, tokenHash: string): Promise<void> {
    this.updateHashCalls += 1;
    const t = this.tokens.find((x) => x._id === id);
    if (t) t.tokenHash = tokenHash;
  }
  async findByUserId(): Promise<TokenDoc[]> {
    return [];
  }
  async findAll(): Promise<TokenDoc[]> {
    return [...this.tokens];
  }
  async findById(id: string): Promise<TokenDoc | null> {
    return this.tokens.find((t) => t._id === id) ?? null;
  }
  async deleteById(): Promise<void> {}
  async findAllPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
}

const PEPPER = randomBytes(32);

describe("hashToken — pepper", () => {
  it("falls back to legacy SHA-256 when no pepper is configured", () => {
    expect(hashToken("tok", null)).toBe(hashTokenLegacy("tok"));
  });

  it("produces a v2-tagged HMAC distinct from legacy when peppered", () => {
    const hashed = hashToken("tok", PEPPER);
    expect(hashed.startsWith("v2:")).toBe(true);
    expect(hashed).not.toBe(hashTokenLegacy("tok"));
  });

  it("a different pepper yields a different hash for the same token", () => {
    expect(hashToken("tok", PEPPER)).not.toBe(hashToken("tok", randomBytes(32)));
  });
});

describe("findTokenForRawToken", () => {
  it("finds a v2-stored token under the active pepper scheme", async () => {
    const repo = new MemoryTokenRepo();
    const { rawToken } = await createApiToken(repo, "u1", "cli"); // born under... default env scheme
    // force the stored hash to the peppered scheme to simulate a v2-native token
    repo.tokens[0].tokenHash = hashToken(rawToken, PEPPER);

    const found = await findTokenForRawToken(repo, rawToken, PEPPER);
    expect(found?._id).toBe(repo.tokens[0]._id);
    expect(repo.updateHashCalls).toBe(0); // already v2 → no upgrade
  });

  it("finds a legacy-stored token when peppered and lazily upgrades it to v2", async () => {
    const repo = new MemoryTokenRepo();
    const { rawToken } = await createApiToken(repo, "u1", "cli");
    repo.tokens[0].tokenHash = hashTokenLegacy(rawToken); // legacy row

    const found = await findTokenForRawToken(repo, rawToken, PEPPER);

    expect(found).not.toBeNull();
    expect(repo.updateHashCalls).toBe(1);
    expect(repo.tokens[0].tokenHash).toBe(hashToken(rawToken, PEPPER)); // upgraded in place
  });

  it("finds a legacy token without a pepper and does not upgrade", async () => {
    const repo = new MemoryTokenRepo();
    const { rawToken } = await createApiToken(repo, "u1", "cli");
    repo.tokens[0].tokenHash = hashTokenLegacy(rawToken);

    const found = await findTokenForRawToken(repo, rawToken, null);

    expect(found).not.toBeNull();
    expect(repo.updateHashCalls).toBe(0);
  });

  it("returns null for an unknown token", async () => {
    const repo = new MemoryTokenRepo();
    expect(await findTokenForRawToken(repo, "tulip_nope", PEPPER)).toBeNull();
  });
});
