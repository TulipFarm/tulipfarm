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

export interface SecretRepo {
  findByKey(key: string): Promise<SecretDoc | null>;
  upsert(key: string, fields: SecretEnvelopeFields): Promise<void>;
}

export class MongoSecretRepo implements SecretRepo {
  private readonly collection: Collection<SecretDoc>;

  constructor(db: Db) {
    this.collection = db.collection<SecretDoc>("secrets");
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
}
