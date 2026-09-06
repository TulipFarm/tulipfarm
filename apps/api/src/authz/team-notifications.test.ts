import {
  InMemoryTeamNotificationRepo,
  type TeamMembershipRecord,
  type TeamRepo,
} from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { TeamNotificationService } from "./team-notifications";

const NOW = new Date("2026-09-05T10:00:00.000Z");
const membership = (overrides: Partial<TeamMembershipRecord> = {}): TeamMembershipRecord => ({
  teamId: "team-1",
  principalId: "person-1",
  principalKind: "user",
  level: "member",
  revision: 1,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

function service(all: TeamMembershipRecord[] = []) {
  return new TeamNotificationService(
    new InMemoryTeamNotificationRepo(),
    {
      listAllPrincipalMemberships: async () => all,
    } as Pick<TeamRepo, "listAllPrincipalMemberships">,
    () => NOW
  );
}

describe("TeamNotificationService", () => {
  it("notifies only affected people and does not expose Team details", async () => {
    const notifications = service();
    await notifications.hierarchyChanged({
      businessId: "business-1",
      teamId: "team-secret",
      recipients: [
        { principalId: "person-1", principalKind: "user", changed: true },
        { principalId: "person-2", principalKind: "user", changed: false },
        { principalId: "agent-1", principalKind: "agent", changed: true },
      ],
      impactDigest: "digest-1",
      occurredAt: NOW,
    });

    const items = await notifications.listForPrincipal("business-1", "person-1");
    expect(items).toEqual([
      expect.objectContaining({
        kind: "hierarchy_access_changed",
        title: "A Team move changed your access",
      }),
    ]);
    expect(JSON.stringify(items)).not.toContain("team-secret");
    await expect(notifications.listForPrincipal("business-1", "person-2")).resolves.toEqual([]);
  });

  it("projects promotion, demotion, expiry warning, and expiry once", async () => {
    const expiring = membership({
      expiresAt: new Date("2026-09-06T10:00:00.000Z"),
      revision: 2,
    });
    const notifications = service([expiring]);
    await notifications.membershipChanged({
      businessId: "business-1",
      teamId: "team-1",
      previous: membership(),
      membership: membership({ level: "admin", revision: 2 }),
    });
    await notifications.membershipChanged({
      businessId: "business-1",
      teamId: "team-1",
      previous: membership({ level: "admin", revision: 2 }),
      membership: membership({ level: "member", revision: 3 }),
    });

    const first = await notifications.listForPrincipal("business-1", "person-1");
    const second = await notifications.listForPrincipal("business-1", "person-1");
    expect(first.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["expiry_warning", "admin_demoted", "admin_promoted"])
    );
    expect(second).toEqual(first);
  });
});
