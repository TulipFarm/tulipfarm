import type { Db } from "mongodb";

export interface DataMigration {
  version: number;
  description: string;
  up: (db: Db) => Promise<void>;
}

export const DATA_MIGRATIONS: DataMigration[] = [
  {
    version: 1,
    description: "Create unique index on users.email",
    up: async (db) => {
      await db.collection("users").createIndex({ email: 1 }, { unique: true });
    },
  },
  {
    version: 2,
    description: "Create unique index on api_tokens.tokenHash",
    up: async (db) => {
      await db.collection("api_tokens").createIndex({ tokenHash: 1 }, { unique: true });
    },
  },
  {
    version: 3,
    description: "Create unique index on secrets.key",
    up: async (db) => {
      await db.collection("secrets").createIndex({ key: 1 }, { unique: true });
    },
  },
  {
    version: 4,
    description: "Create index on conversations.userId",
    up: async (db) => {
      await db.collection("conversations").createIndex({ userId: 1 });
    },
  },
];
