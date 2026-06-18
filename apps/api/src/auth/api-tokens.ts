import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Queryable } from "../db";
import { type PaginatedResult, toPage } from "../pagination";

// Version tag distinguishing pepper-hashed (HMAC) token hashes from legacy bare-SHA-256 ones.
// Legacy hashes are unprefixed 64-char hex; v2 hashes carry this prefix. The prefix can never
// collide with hex, so both schemes coexist in the UNIQUE token_hash column during migration.
const HASH_V2_PREFIX = "v2:";

// The server-held pepper. When set, token hashes are HMAC-SHA256(token, pepper) — a DB dump alone
// then can't verify token guesses. Absent → legacy SHA-256 (acceptable for high-entropy tokens).
function loadPepper(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  return env.API_TOKEN_PEPPER ? Buffer.from(env.API_TOKEN_PEPPER, "base64") : null;
}

// Legacy (v1) hash: bare SHA-256 hex. Kept for verifying tokens minted before the pepper.
export function hashTokenLegacy(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export interface TokenDoc {
  _id: string;
  userId: string;
  name: string;
  tokenHash: string;
  prefix: string;
  createdAt: Date;
}

export interface PublicToken {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  createdAt: Date;
}

export function toPublicToken(token: TokenDoc): PublicToken {
  return {
    id: token._id,
    userId: token.userId,
    name: token.name,
    prefix: token.prefix,
    createdAt: token.createdAt,
  };
}

// Active hashing scheme: HMAC + pepper (tagged `v2:`) when a pepper is configured, else legacy
// SHA-256. New tokens are born under whichever scheme is active.
export function hashToken(rawToken: string, pepper: Buffer | null = loadPepper()): string {
  if (!pepper) return hashTokenLegacy(rawToken);
  return HASH_V2_PREFIX + createHmac("sha256", pepper).update(rawToken).digest("hex");
}

// Resolve a raw bearer token to its stored row, transparently bridging the hashing schemes:
//  1. Look up under the active scheme (v2 when a pepper is set, else v1).
//  2. If a pepper is set and that misses, the row may predate the pepper — look up under legacy
//     v1, and on a hit lazily upgrade it to v2 so it migrates on first use.
export async function findTokenForRawToken(
  repo: TokenRepo,
  rawToken: string,
  pepper: Buffer | null = loadPepper()
): Promise<TokenDoc | null> {
  const primary = await repo.findByHash(hashToken(rawToken, pepper));
  if (primary) return primary;

  if (pepper) {
    const legacy = await repo.findByHash(hashTokenLegacy(rawToken));
    if (legacy) {
      await repo.updateHash?.(legacy._id, hashToken(rawToken, pepper));
      return legacy;
    }
  }
  return null;
}

function generateRawToken(): string {
  return `tulip_${randomBytes(32).toString("base64url")}`;
}

export interface TokenRepo {
  create(token: TokenDoc): Promise<void>;
  findByHash(hash: string): Promise<TokenDoc | null>;
  // Optional: lazy re-hash of a legacy token to the active scheme on successful auth. Best-effort
  // optimization — auth still works without it, so non-persistent fakes may omit it.
  updateHash?(id: string, tokenHash: string): Promise<void>;
  findByUserId(userId: string): Promise<TokenDoc[]>;
  findAll(): Promise<TokenDoc[]>;
  findById(id: string): Promise<TokenDoc | null>;
  deleteById(id: string): Promise<void>;
  findAllPaginated(
    limit: number,
    after?: { createdAt: Date; _id: string }
  ): Promise<PaginatedResult<TokenDoc>>;
  findByUserIdPaginated(
    userId: string,
    limit: number,
    after?: { createdAt: Date; _id: string }
  ): Promise<PaginatedResult<TokenDoc>>;
}

function rowToToken(row: Record<string, unknown>): TokenDoc {
  return {
    _id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    tokenHash: row.token_hash as string,
    prefix: row.prefix as string,
    createdAt: row.created_at as Date,
  };
}

export class PgTokenRepo implements TokenRepo {
  constructor(private readonly q: Queryable) {}

  async create(token: TokenDoc): Promise<void> {
    await this.q.query(
      "INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [token._id, token.userId, token.name, token.tokenHash, token.prefix, token.createdAt]
    );
  }

  async findByHash(hash: string): Promise<TokenDoc | null> {
    const { rows } = await this.q.query("SELECT * FROM api_tokens WHERE token_hash = $1", [hash]);
    return rows.length > 0 ? rowToToken(rows[0]) : null;
  }

  async updateHash(id: string, tokenHash: string): Promise<void> {
    await this.q.query("UPDATE api_tokens SET token_hash = $2 WHERE id = $1", [id, tokenHash]);
  }

  async findByUserId(userId: string): Promise<TokenDoc[]> {
    const { rows } = await this.q.query(
      "SELECT * FROM api_tokens WHERE user_id = $1 ORDER BY created_at, id",
      [userId]
    );
    return rows.map(rowToToken);
  }

  async findAll(): Promise<TokenDoc[]> {
    const { rows } = await this.q.query("SELECT * FROM api_tokens ORDER BY created_at, id");
    return rows.map(rowToToken);
  }

  async findById(id: string): Promise<TokenDoc | null> {
    const { rows } = await this.q.query("SELECT * FROM api_tokens WHERE id = $1", [id]);
    return rows.length > 0 ? rowToToken(rows[0]) : null;
  }

  async deleteById(id: string): Promise<void> {
    await this.q.query("DELETE FROM api_tokens WHERE id = $1", [id]);
  }

  async findAllPaginated(
    limit: number,
    after?: { createdAt: Date; _id: string }
  ): Promise<PaginatedResult<TokenDoc>> {
    const { rows } = after
      ? await this.q.query(
          "SELECT * FROM api_tokens WHERE (created_at, id) > ($1, $2) ORDER BY created_at, id LIMIT $3",
          [after.createdAt, after._id, limit + 1]
        )
      : await this.q.query("SELECT * FROM api_tokens ORDER BY created_at, id LIMIT $1", [
          limit + 1,
        ]);
    return toPage(rows.map(rowToToken), limit);
  }

  async findByUserIdPaginated(
    userId: string,
    limit: number,
    after?: { createdAt: Date; _id: string }
  ): Promise<PaginatedResult<TokenDoc>> {
    const { rows } = after
      ? await this.q.query(
          "SELECT * FROM api_tokens WHERE user_id = $1 AND (created_at, id) > ($2, $3) ORDER BY created_at, id LIMIT $4",
          [userId, after.createdAt, after._id, limit + 1]
        )
      : await this.q.query(
          "SELECT * FROM api_tokens WHERE user_id = $1 ORDER BY created_at, id LIMIT $2",
          [userId, limit + 1]
        );
    return toPage(rows.map(rowToToken), limit);
  }
}

export async function createApiToken(
  repo: TokenRepo,
  userId: string,
  name: string
): Promise<{ doc: TokenDoc; rawToken: string }> {
  const rawToken = generateRawToken();
  const doc: TokenDoc = {
    _id: randomUUID(),
    userId,
    name,
    tokenHash: hashToken(rawToken),
    prefix: rawToken.slice(0, 10),
    createdAt: new Date(),
  };
  await repo.create(doc);
  return { doc, rawToken };
}
