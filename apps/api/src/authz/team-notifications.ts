import { randomUUID } from "node:crypto";
import type {
  TeamMembershipRecord,
  TeamNotificationKind,
  TeamNotificationRepo,
  TeamRepo,
} from "@tulipfarm/storage";

const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

export interface TeamNotificationItem {
  readonly id: string;
  readonly kind: TeamNotificationKind;
  readonly title: string;
  readonly createdAt: string;
}

function title(kind: TeamNotificationKind): string {
  switch (kind) {
    case "membership_added":
      return "You were added to a Team";
    case "membership_removed":
      return "Your Team membership was removed";
    case "admin_promoted":
      return "You were promoted to Team admin";
    case "admin_demoted":
      return "Your Team admin access was removed";
    case "expiry_warning":
      return "Your Team membership expires soon";
    case "membership_expired":
      return "Your Team membership expired";
    case "hierarchy_access_changed":
      return "A Team move changed your access";
  }
}

export class TeamNotificationService {
  constructor(
    private readonly repo: TeamNotificationRepo,
    private readonly teams: Pick<TeamRepo, "listAllPrincipalMemberships">,
    private readonly now: () => Date = () => new Date()
  ) {}

  async membershipChanged(input: {
    readonly businessId: string;
    readonly teamId: string;
    readonly membership: TeamMembershipRecord;
    readonly previous?: TeamMembershipRecord;
    readonly removed?: boolean;
  }): Promise<void> {
    const { membership, previous } = input;
    if (membership.principalKind !== "user") return;
    const base = `${input.teamId}:${membership.principalId}:${membership.revision}`;
    if (input.removed) {
      await this.put(input, "membership_removed", `${base}:removed`);
      if (membership.level === "admin") {
        await this.put(input, "admin_demoted", `${base}:admin-demoted`);
      }
      return;
    }
    if (!previous) {
      await this.put(input, "membership_added", `${base}:added`);
      if (membership.level === "admin") {
        await this.put(input, "admin_promoted", `${base}:admin-promoted`);
      }
    } else if (previous.level !== membership.level) {
      await this.put(
        input,
        membership.level === "admin" ? "admin_promoted" : "admin_demoted",
        `${base}:${membership.level}`
      );
    }
    await this.putExpiryIfNeeded(input.businessId, membership);
  }

  async hierarchyChanged(input: {
    readonly businessId: string;
    readonly teamId: string;
    readonly recipients: readonly {
      readonly principalId: string;
      readonly principalKind: string;
      readonly changed: boolean;
    }[];
    readonly impactDigest: string;
    readonly occurredAt: Date;
  }): Promise<void> {
    for (const recipient of input.recipients) {
      if (recipient.principalKind !== "user" || !recipient.changed) continue;
      await this.repo.put({
        id: randomUUID(),
        businessId: input.businessId,
        recipientPrincipalId: recipient.principalId,
        teamId: input.teamId,
        kind: "hierarchy_access_changed",
        dedupeKey: `hierarchy:${input.teamId}:${input.impactDigest}:${recipient.principalId}`,
        createdAt: input.occurredAt,
      });
    }
  }

  async listForPrincipal(businessId: string, principalId: string): Promise<TeamNotificationItem[]> {
    const memberships = await this.teams.listAllPrincipalMemberships(businessId, principalId);
    await Promise.all(
      memberships.map((membership) => this.putExpiryIfNeeded(businessId, membership))
    );
    return (await this.repo.listForRecipient(businessId, principalId)).map((record) => ({
      id: record.id,
      kind: record.kind,
      title: title(record.kind),
      createdAt: record.createdAt.toISOString(),
    }));
  }

  private async putExpiryIfNeeded(
    businessId: string,
    membership: TeamMembershipRecord
  ): Promise<void> {
    if (membership.principalKind !== "user" || !membership.expiresAt) return;
    const now = this.now();
    const remaining = membership.expiresAt.getTime() - now.getTime();
    const kind =
      remaining <= 0
        ? "membership_expired"
        : remaining <= EXPIRY_WARNING_MS
          ? "expiry_warning"
          : undefined;
    if (!kind) return;
    await this.repo.put({
      id: randomUUID(),
      businessId,
      recipientPrincipalId: membership.principalId,
      teamId: membership.teamId,
      kind,
      dedupeKey: `${kind}:${membership.teamId}:${membership.principalId}:${membership.revision}`,
      createdAt: now,
    });
  }

  private async put(
    input: {
      readonly businessId: string;
      readonly teamId: string;
      readonly membership: TeamMembershipRecord;
    },
    kind: TeamNotificationKind,
    dedupeKey: string
  ): Promise<void> {
    await this.repo.put({
      id: randomUUID(),
      businessId: input.businessId,
      recipientPrincipalId: input.membership.principalId,
      teamId: input.teamId,
      kind,
      dedupeKey,
      createdAt: this.now(),
    });
  }
}
