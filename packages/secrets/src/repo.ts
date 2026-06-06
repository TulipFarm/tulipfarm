import { randomUUID } from "node:crypto";
import type { Collection, Db } from "mongodb";

export type SecretType = "user-provided" | "auto-generated";

export interface SecretDoc {
  _id: string;
  key: string;
  encryptedValue: string; // base64
  iv: string; // base64
  authTag: string; // base64
  type: SecretType;
  createdAt: Date;
  updatedAt: Date;
}

// Fields written on every upsert (the encrypted envelope + metadata). No plaintext.
export interface SecretEnvelopeFields {
  encryptedValue: string;
  iv: string;
  authTag: string;
  type: SecretType;
}

export interface SecretMeta {
  key: string;
  type: SecretType;
  createdAt: Date;
  updatedAt: Date;
}

export interface SecretRepo {
  list(): Promise<SecretMeta[]>;
  findByKey(key: string): Promise<SecretDoc | null>;
  upsert(key: string, fields: SecretEnvelopeFields): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MongoSecretRepo implements SecretRepo {
  private readonly collection: Collection<SecretDoc>;

  constructor(db: Db) {
    this.collection = db.collection<SecretDoc>("secrets");
  }

  async list(): Promise<SecretMeta[]> {
    const docs = await this.collection.find({}).toArray();
    return docs.map(({ key, type, createdAt, updatedAt }) => ({ key, type, createdAt, updatedAt }));
  }

  findByKey(key: string): Promise<SecretDoc | null> {
    return this.collection.findOne({ key });
  }

  async upsert(key: string, fields: SecretEnvelopeFields): Promise<void> {
    const now = new Date();
    await this.collection.updateOne(
      { key },
      {
        $set: { ...fields, updatedAt: now },
        $setOnInsert: { _id: randomUUID(), key, createdAt: now },
      },
      { upsert: true }
    );
  }

  async delete(key: string): Promise<void> {
    await this.collection.deleteOne({ key });
  }
}
