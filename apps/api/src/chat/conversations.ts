import type { Collection, Db } from "mongodb";

export interface ConversationDoc {
  _id: string;
  userId?: string;
  agentId?: string;
  // Conversation-level configured default model (tier name or model id). The
  // per-turn `model` override bypasses this without mutating it.
  // TODO: agent-config-derived default model is deferred to a later ticket.
  model?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationRepo {
  create(doc: ConversationDoc): Promise<void>;
  findById(id: string): Promise<ConversationDoc | null>;
  touch(id: string): Promise<void>;
}

export class ConversationOwnerlessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationOwnerlessError";
  }
}

export class MongoConversationRepo implements ConversationRepo {
  private readonly collection: Collection<ConversationDoc>;

  constructor(db: Db) {
    this.collection = db.collection<ConversationDoc>("conversations");
  }

  async create(doc: ConversationDoc): Promise<void> {
    if (doc.userId == null && doc.agentId == null) {
      throw new ConversationOwnerlessError("conversation must have a userId or agentId");
    }
    await this.collection.insertOne(doc);
  }

  findById(id: string): Promise<ConversationDoc | null> {
    return this.collection.findOne({ _id: id });
  }

  async touch(id: string): Promise<void> {
    await this.collection.updateOne({ _id: id }, { $set: { updatedAt: new Date() } });
  }
}
