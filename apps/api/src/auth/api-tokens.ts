import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Collection, Db } from "mongodb";

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

export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

function generateRawToken(): string {
  return `tulip_${randomBytes(32).toString("base64url")}`;
}

export interface TokenRepo {
  create(token: TokenDoc): Promise<void>;
  findByHash(hash: string): Promise<TokenDoc | null>;
  findByUserId(userId: string): Promise<TokenDoc[]>;
  findAll(): Promise<TokenDoc[]>;
  findById(id: string): Promise<TokenDoc | null>;
  deleteById(id: string): Promise<void>;
}

export class MongoTokenRepo implements TokenRepo {
  private readonly collection: Collection<TokenDoc>;

  constructor(db: Db) {
    this.collection = db.collection<TokenDoc>("api_tokens");
  }

  async create(token: TokenDoc): Promise<void> {
    await this.collection.insertOne(token);
  }

  findByHash(hash: string): Promise<TokenDoc | null> {
    return this.collection.findOne({ tokenHash: hash });
  }

  findByUserId(userId: string): Promise<TokenDoc[]> {
    return this.collection.find({ userId }).toArray();
  }

  findAll(): Promise<TokenDoc[]> {
    return this.collection.find().toArray();
  }

  findById(id: string): Promise<TokenDoc | null> {
    return this.collection.findOne({ _id: id });
  }

  async deleteById(id: string): Promise<void> {
    await this.collection.deleteOne({ _id: id });
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
