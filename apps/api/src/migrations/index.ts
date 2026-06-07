import type { Db } from "mongodb";

export interface DataMigration {
  version: number;
  description: string;
  up: (db: Db) => Promise<void>;
}

interface EmbeddedMessage {
  role: string;
  content: unknown;
  createdAt?: Date;
}

interface EmbeddedConv {
  _id: string;
  createdAt?: Date;
  messages?: EmbeddedMessage[];
}

interface BackfilledMessageDoc {
  _id: string;
  conversationId: string;
  role: string;
  content: unknown;
  createdAt: Date;
}

export function buildBackfillDocs(conv: EmbeddedConv): BackfilledMessageDoc[] {
  const messages = conv.messages;
  if (!messages || messages.length === 0) {
    return [];
  }
  return messages.map((m, i) => ({
    _id: `${conv._id}:${String(i).padStart(6, "0")}`,
    conversationId: conv._id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt ?? conv.createdAt ?? new Date(),
  }));
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
  {
    version: 5,
    description: "messages collection: index + backfill from embedded conversation.messages",
    up: async (db) => {
      const messages = db.collection<BackfilledMessageDoc>("messages");
      const conversations = db.collection<EmbeddedConv>("conversations");
      await messages.createIndex({ conversationId: 1, createdAt: 1, _id: 1 });
      const cursor = conversations.find({ messages: { $exists: true } });
      try {
        for await (const conv of cursor) {
          const backfillDocs = buildBackfillDocs(conv);
          for (const message of backfillDocs) {
            await messages.replaceOne({ _id: message._id }, message, { upsert: true });
          }
          await conversations.updateOne({ _id: conv._id }, { $unset: { messages: "" } });
        }
      } finally {
        await cursor.close();
      }
    },
  },
  {
    version: 6,
    description: "Create working_memory indexes (unique userId+key, per-user LRU listing)",
    up: async (db) => {
      const col = db.collection("working_memory");
      await col.createIndex({ userId: 1, key: 1 }, { unique: true });
      await col.createIndex({ userId: 1, lastWrittenAt: 1 });
    },
  },
];
