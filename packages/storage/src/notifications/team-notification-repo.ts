import type { Queryable } from "../ports";

export type TeamNotificationKind =
  | "membership_added"
  | "membership_removed"
  | "admin_promoted"
  | "admin_demoted"
  | "expiry_warning"
  | "membership_expired"
  | "hierarchy_access_changed";

export interface TeamNotificationRecord {
  readonly id: string;
  readonly businessId: string;
  readonly recipientPrincipalId: string;
  readonly teamId: string;
  readonly kind: TeamNotificationKind;
  readonly dedupeKey: string;
  readonly createdAt: Date;
}

export interface TeamNotificationRepo {
  put(record: TeamNotificationRecord): Promise<void>;
  listForRecipient(
    businessId: string,
    recipientPrincipalId: string,
    limit?: number
  ): Promise<TeamNotificationRecord[]>;
}

function clone(record: TeamNotificationRecord): TeamNotificationRecord {
  return Object.freeze({ ...record, createdAt: new Date(record.createdAt.getTime()) });
}

export class InMemoryTeamNotificationRepo implements TeamNotificationRepo {
  private readonly records = new Map<string, TeamNotificationRecord>();

  async put(record: TeamNotificationRecord): Promise<void> {
    if (![...this.records.values()].some((item) => item.dedupeKey === record.dedupeKey)) {
      this.records.set(record.id, clone(record));
    }
  }

  async listForRecipient(
    businessId: string,
    recipientPrincipalId: string,
    limit = 100
  ): Promise<TeamNotificationRecord[]> {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.businessId === businessId && record.recipientPrincipalId === recipientPrincipalId
      )
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, limit)
      .map(clone);
  }
}

interface NotificationRow {
  id: string;
  business_id: string;
  recipient_principal_id: string;
  team_id: string;
  kind: TeamNotificationKind;
  dedupe_key: string;
  created_at: Date | string;
}

function fromRow(row: NotificationRow): TeamNotificationRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    recipientPrincipalId: row.recipient_principal_id,
    teamId: row.team_id,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    createdAt: new Date(row.created_at),
  };
}

export class PgTeamNotificationRepo implements TeamNotificationRepo {
  constructor(private readonly db: Queryable) {}

  async put(record: TeamNotificationRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO team_notifications (
         id, business_id, recipient_principal_id, team_id, kind, dedupe_key, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (business_id, dedupe_key) DO NOTHING`,
      [
        record.id,
        record.businessId,
        record.recipientPrincipalId,
        record.teamId,
        record.kind,
        record.dedupeKey,
        record.createdAt,
      ]
    );
  }

  async listForRecipient(
    businessId: string,
    recipientPrincipalId: string,
    limit = 100
  ): Promise<TeamNotificationRecord[]> {
    const result = await this.db.query<NotificationRow>(
      `SELECT id, business_id, recipient_principal_id, team_id, kind, dedupe_key, created_at
         FROM team_notifications
        WHERE business_id = $1 AND recipient_principal_id = $2
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [businessId, recipientPrincipalId, Math.min(Math.max(limit, 1), 200)]
    );
    return result.rows.map(fromRow);
  }
}

export const TEAM_NOTIFICATION_STORAGE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS team_notifications (
    id uuid PRIMARY KEY,
    business_id text NOT NULL,
    recipient_principal_id text NOT NULL,
    team_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN (
      'membership_added', 'membership_removed', 'admin_promoted', 'admin_demoted',
      'expiry_warning', 'membership_expired', 'hierarchy_access_changed'
    )),
    dedupe_key text NOT NULL,
    created_at timestamptz NOT NULL,
    UNIQUE (business_id, dedupe_key)
  )`,
  `CREATE INDEX IF NOT EXISTS team_notifications_recipient_idx
     ON team_notifications (business_id, recipient_principal_id, created_at DESC)`,
] as const;
