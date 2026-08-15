import type { PaginatedResult } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import {
  createApiToken,
  hashToken,
  type TokenDoc,
  type TokenRepo,
  toPublicToken,
} from "./api-tokens";

class MemoryTokenRepo implements TokenRepo {
  private tokens: TokenDoc[] = [];

  async create(token: TokenDoc): Promise<void> {
    this.tokens.push(token);
  }
  async findByHash(hash: string): Promise<TokenDoc | null> {
    return this.tokens.find((t) => t.tokenHash === hash) ?? null;
  }
  async findByUserId(userId: string): Promise<TokenDoc[]> {
    return this.tokens.filter((t) => t.userId === userId);
  }
  async findAll(): Promise<TokenDoc[]> {
    return [...this.tokens];
  }
  async findById(id: string): Promise<TokenDoc | null> {
    return this.tokens.find((t) => t._id === id) ?? null;
  }
  async deleteById(id: string): Promise<void> {
    this.tokens = this.tokens.filter((t) => t._id !== id);
  }
  async findAllPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [...this.tokens], nextCursor: null };
  }
  async findByUserIdPaginated(userId: string): Promise<PaginatedResult<TokenDoc>> {
    return { items: this.tokens.filter((t) => t.userId === userId), nextCursor: null };
  }
}

describe("hashToken", () => {
  it("returns consistent hex string for same input", () => {
    expect(hashToken("test")).toBe(hashToken("test"));
  });

  it("returns different hashes for different inputs", () => {
    expect(hashToken("a")).not.toBe(hashToken("b"));
  });

  it("hash is not equal to raw token", () => {
    expect(hashToken("tulip_abc")).not.toBe("tulip_abc");
  });
});

describe("createApiToken", () => {
  it("stores token with correct userId and name", async () => {
    const repo = new MemoryTokenRepo();
    const { doc, rawToken } = await createApiToken(repo, "user-1", "my-cli");

    expect(doc.userId).toBe("user-1");
    expect(doc.name).toBe("my-cli");
    expect(rawToken.startsWith("tulip_")).toBe(true);
    expect(rawToken).toHaveLength(49);
  });

  it("stores hash of raw token, not plaintext", async () => {
    const repo = new MemoryTokenRepo();
    const { doc, rawToken } = await createApiToken(repo, "user-1", "ci");

    expect(doc.tokenHash).not.toBe(rawToken);
    expect(doc.tokenHash).toBe(hashToken(rawToken));
  });

  it("prefix is first 10 chars of raw token", async () => {
    const repo = new MemoryTokenRepo();
    const { doc, rawToken } = await createApiToken(repo, "user-1", "ci");

    expect(doc.prefix).toBe(rawToken.slice(0, 10));
  });

  it("findByHash returns the stored token", async () => {
    const repo = new MemoryTokenRepo();
    const { doc, rawToken } = await createApiToken(repo, "user-1", "ci");

    const found = await repo.findByHash(hashToken(rawToken));
    expect(found?._id).toBe(doc._id);
  });

  it("deleteById removes the token", async () => {
    const repo = new MemoryTokenRepo();
    const { doc } = await createApiToken(repo, "user-1", "ci");

    await repo.deleteById(doc._id);
    expect(await repo.findById(doc._id)).toBeNull();
  });

  it("two tokens for same user have different raw values and hashes", async () => {
    const repo = new MemoryTokenRepo();
    const a = await createApiToken(repo, "user-1", "a");
    const b = await createApiToken(repo, "user-1", "b");

    expect(a.rawToken).not.toBe(b.rawToken);
    expect(a.doc.tokenHash).not.toBe(b.doc.tokenHash);
  });
});

describe("toPublicToken", () => {
  it("omits tokenHash", () => {
    const doc: TokenDoc = {
      _id: "id-1",
      userId: "u-1",
      name: "cli",
      tokenHash: "secret",
      prefix: "tulip_ab12",
      createdAt: new Date(),
    };
    const pub = toPublicToken(doc);
    expect("tokenHash" in pub).toBe(false);
    expect(pub.id).toBe("id-1");
  });
});
