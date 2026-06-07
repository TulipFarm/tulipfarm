import type { Collection, Db } from "mongodb";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

export interface ConversationDoc {
  _id: string;
  userId: string;
  // Conversation-level configured default model (tier name or model id). The
  // per-turn `model` override bypasses this without mutating it.
  // TODO: agent-config-derived default model is deferred to a later ticket.
  model?: string;
  messages: ConversationMessage[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationRepo {
  create(doc: ConversationDoc): Promise<void>;
  findById(id: string): Promise<ConversationDoc | null>;
  appendMessage(id: string, message: ConversationMessage): Promise<void>;
}

export class MongoConversationRepo implements ConversationRepo {
  private readonly collection: Collection<ConversationDoc>;

  constructor(db: Db) {
    this.collection = db.collection<ConversationDoc>("conversations");
  }

  async create(doc: ConversationDoc): Promise<void> {
    await this.collection.insertOne(doc);
  }

  findById(id: string): Promise<ConversationDoc | null> {
    return this.collection.findOne({ _id: id });
  }

  async appendMessage(id: string, message: ConversationMessage): Promise<void> {
    await this.collection.updateOne(
      { _id: id },
      { $push: { messages: message }, $set: { updatedAt: new Date() } }
    );
  }
}
