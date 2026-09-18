import { OimKnowledgeSubscriptionStore } from "@tulipfarm/storage";
import type { Queryable } from "../db";
import type { PersistedOimKnowledgeRegistration } from "../internal/oim-worker-host";

export class PgOimKnowledgeRegistrationReader {
  private readonly subscriptions: OimKnowledgeSubscriptionStore;

  constructor(queryable: Queryable) {
    this.subscriptions = new OimKnowledgeSubscriptionStore(queryable);
  }

  async list(): Promise<readonly PersistedOimKnowledgeRegistration[]> {
    return this.subscriptions.listEnabled();
  }
}
