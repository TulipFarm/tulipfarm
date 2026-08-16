import { randomUUID } from "node:crypto";
import type { Queryable } from "../db";

export interface IntegrationConversation {
  integrationSlug: string;
  externalKey: string;
  conversationId: string;
  userId: string;
}

export interface IntegrationEvent {
  id: string;
  integrationSlug: string;
  protocol: string;
  eventType: string;
  externalId?: string;
  payload: Record<string, unknown>;
}

export class IntegrationConversationsRepo {
  constructor(private readonly db: Queryable) {}

  async find(
    integrationSlug: string,
    externalKey: string
  ): Promise<IntegrationConversation | null> {
    const r = await this.db.query(
      "SELECT integration_slug, external_key, conversation_id, user_id FROM integration_conversations WHERE integration_slug = $1 AND external_key = $2",
      [integrationSlug, externalKey]
    );
    const row = r.rows[0] as
      | { integration_slug: string; external_key: string; conversation_id: string; user_id: string }
      | undefined;
    if (!row) return null;
    return {
      integrationSlug: row.integration_slug,
      externalKey: row.external_key,
      conversationId: row.conversation_id,
      userId: row.user_id,
    };
  }

  async exists(integrationSlug: string, externalKey: string): Promise<boolean> {
    const r = await this.db.query(
      "SELECT 1 FROM integration_conversations WHERE integration_slug = $1 AND external_key = $2",
      [integrationSlug, externalKey]
    );
    return r.rows.length > 0;
  }

  /**
   * Insert a mapping and return the row that actually maps the thread. On a concurrent conflict
   * the first writer keeps the row, so a losing caller gets the *winner's* mapping back — never
   * the values it tried to write. Callers must route on the returned `conversationId` rather than
   * trusting the id they minted, or two first messages fork one thread into two Conversations.
   */
  async insert(doc: IntegrationConversation): Promise<IntegrationConversation> {
    const inserted = await this.db.query(
      "INSERT INTO integration_conversations (integration_slug, external_key, conversation_id, user_id) VALUES ($1, $2, $3, $4) ON CONFLICT (integration_slug, external_key) DO NOTHING RETURNING integration_slug, external_key, conversation_id, user_id",
      [doc.integrationSlug, doc.externalKey, doc.conversationId, doc.userId]
    );
    const row = inserted.rows[0] as
      | { integration_slug: string; external_key: string; conversation_id: string; user_id: string }
      | undefined;
    if (row) {
      return {
        integrationSlug: row.integration_slug,
        externalKey: row.external_key,
        conversationId: row.conversation_id,
        userId: row.user_id,
      };
    }
    // DO NOTHING returned no row: a concurrent writer already holds the key. Re-read to learn the
    // winner instead of assuming our own insert took effect.
    const winner = await this.find(doc.integrationSlug, doc.externalKey);
    if (winner === null) {
      throw new Error(
        `integration_conversations mapping vanished after conflict: ${doc.integrationSlug}:${doc.externalKey}`
      );
    }
    return winner;
  }
}

export class IntegrationEventsRepo {
  constructor(private readonly db: Queryable) {}

  async insert(doc: Omit<IntegrationEvent, "id">): Promise<IntegrationEvent> {
    const id = randomUUID();
    await this.db.query(
      "INSERT INTO integration_events (id, integration_slug, protocol, event_type, external_id, payload) VALUES ($1, $2, $3, $4, $5, $6)",
      [
        id,
        doc.integrationSlug,
        doc.protocol,
        doc.eventType,
        doc.externalId ?? null,
        JSON.stringify(doc.payload),
      ]
    );
    return { id, ...doc };
  }
}

const DELIVERY_RETENTION = "7 days";
const PRUNE_PROBABILITY = 0.01;

export class IngressDeliveriesRepo {
  constructor(private readonly db: Queryable) {}

  /**
   * Record a delivery attempt. Returns true when this is the FIRST time the key was seen (caller
   * should process) and false on a duplicate (caller should ack + skip). Atomic under concurrent
   * retries via ON CONFLICT DO NOTHING.
   */
  async recordDelivery(integrationSlug: string, dedupKey: string): Promise<boolean> {
    const r = await this.db.query(
      "INSERT INTO ingress_deliveries (integration_slug, dedup_key) VALUES ($1, $2) ON CONFLICT (integration_slug, dedup_key) DO NOTHING RETURNING 1",
      [integrationSlug, dedupKey]
    );
    if (Math.random() < PRUNE_PROBABILITY) {
      await this.db.query(
        `DELETE FROM ingress_deliveries WHERE received_at < now() - interval '${DELIVERY_RETENTION}'`
      );
    }
    return r.rows.length > 0;
  }
}
