import { beforeEach, describe, expect, it } from "vitest";
import { createTriageHarness, type TriageHarness } from "./harness";

/**
 * Duplicate and ambiguous triage effects.
 *
 * Each case injects one real failure mode into the triage flow and asserts the two properties the
 * phase exists to prove: exactly one logical effect per idempotency key, and an ambiguous write
 * resolved against provider state rather than repeated or assumed away. No case may end with an
 * unauthorized close or assignment.
 */

let harness: TriageHarness;

beforeEach(async () => {
  harness = await createTriageHarness();
  harness.github.seedIssue({
    number: 41,
    title: "Uploads fail with 500 on large CSV",
    body: "Uploading a 40MB CSV returns a 500.",
    author: "octo-reporter",
  });
  harness.classify({
    duplicate: false,
    labels: ["bug"],
    summary: "Large CSV upload returns 500",
    reply: "Thanks — tracked internally.",
    candidateAccountIds: ["acct-maya"],
  });
});

async function deliver(deliveryId: string, issueNumber: number) {
  return harness.ingest(harness.signedDelivery({ deliveryId, issueNumber }));
}

describe("duplicate delivery", () => {
  it("collapses a redelivered webhook onto one logical flow and one effect per key", async () => {
    expect(await deliver("delivery-1", 41)).toMatchObject({ outcome: "accepted" });
    expect(await deliver("delivery-1", 41)).toMatchObject({ outcome: "duplicate" });

    const first = await harness.triage({ deliveryId: "delivery-1", issueNumber: 41 });
    const second = await harness.triage({ deliveryId: "delivery-1", issueNumber: 41 });

    expect(first.outcome).toBe("awaiting_approval");
    expect(second.outcome).toBe("awaiting_approval");

    const effects = await harness.effects.list(harness.businessId);
    expect(effects.map((effect) => effect.intent.action)).toEqual([
      "github.issue.label",
      "jira.issue.create",
    ]);
    expect(harness.jira.issues()).toHaveLength(1);
    expect(harness.github.issue(41).labels).toEqual(["bug"]);
  });
});

describe("concurrent issues", () => {
  it("keeps two issues on separate effect keys without cross-contamination", async () => {
    harness.github.seedIssue({ number: 42, title: "Export times out", body: "", author: "octo-2" });
    await deliver("delivery-1", 41);
    await deliver("delivery-2", 42);

    const [a, b] = await Promise.all([
      harness.triage({ deliveryId: "delivery-1", issueNumber: 41 }),
      harness.triage({ deliveryId: "delivery-2", issueNumber: 42 }),
    ]);

    expect(a.outcome).toBe("awaiting_approval");
    expect(b.outcome).toBe("awaiting_approval");
    const effects = await harness.effects.list(harness.businessId);
    expect(new Set(effects.map((effect) => effect.idempotencyKey)).size).toBe(effects.length);
    expect(harness.jira.issues()).toHaveLength(2);
  });
});

describe("ambiguous provider outcomes", () => {
  it("reconciles a GitHub write that succeeded before the response was lost", async () => {
    harness.github.applyThenFail("POST /repos/tulip/farm/issues/41/labels", 503);
    await deliver("delivery-1", 41);

    const result = await harness.triage({ deliveryId: "delivery-1", issueNumber: 41 });
    const step = result.steps.find((entry) => entry.state === "ApplyLabels");
    expect(step?.status).toBe("ambiguous");

    const effect = await harness.effects.get(harness.businessId, step?.effectId as string);
    expect(effect?.state).toBe("ambiguous");

    const reconciled = await harness.reconcile(step?.effectId as string);
    expect(reconciled.outcome).toBe("confirmed");
    expect(harness.github.issue(41).labels).toEqual(["bug"]);
    expect((await harness.effects.get(harness.businessId, step?.effectId as string))?.state).toBe(
      "confirmed"
    );
  });

  it("resolves a Jira outage that never applied the write as not_applied", async () => {
    harness.jira.failNext("POST /rest/api/3/issue", 503);
    await deliver("delivery-1", 41);

    const result = await harness.triage({ deliveryId: "delivery-1", issueNumber: 41 });
    const step = result.steps.find((entry) => entry.state === "CreateTicket");
    expect(step?.status).toBe("ambiguous");

    const reconciled = await harness.reconcile(step?.effectId as string);
    expect(reconciled.outcome).toBe("not_applied");
    expect(harness.jira.issues()).toHaveLength(0);
    expect((await harness.effects.get(harness.businessId, step?.effectId as string))?.state).toBe(
      "failed"
    );
    // The flow stopped at the failed ticket: nothing was assigned on the strength of it.
    expect(harness.github.issue(41).assignees).toEqual([]);
  });

  it("reports a lookup it could not perform as needing attention, never as not applied", async () => {
    harness.jira.applyThenFail("POST /rest/api/3/issue", 503);
    await deliver("delivery-1", 41);
    const result = await harness.triage({ deliveryId: "delivery-1", issueNumber: 41 });
    const step = result.steps.find((entry) => entry.state === "CreateTicket");

    harness.jira.offline = true;
    const reconciled = await harness.reconcile(step?.effectId as string);
    expect(reconciled).toMatchObject({ outcome: "attention_required", reason: "still_ambiguous" });
    expect((await harness.effects.get(harness.businessId, step?.effectId as string))?.state).toBe(
      "reconciliation_required"
    );
  });
});

describe("authorization withdrawn mid-flight", () => {
  it("refuses to dispatch after the Integration grant is revoked", async () => {
    await deliver("delivery-1", 41);
    harness.revokeAccessGrants();

    const result = await harness.triage({ deliveryId: "delivery-1", issueNumber: 41 });

    expect(result.outcome).toBe("blocked");
    expect(result.steps.at(-1)?.status).toBe("failed");
    expect(harness.github.issue(41).labels).toEqual([]);
    expect(harness.github.mutations()).toEqual([]);
  });

  it("refuses to lease a credential once authorization is withdrawn", async () => {
    await deliver("delivery-1", 41);
    harness.revokeAuthorization();

    const result = await harness.triage({ deliveryId: "delivery-1", issueNumber: 41 });

    expect(result.outcome).toBe("blocked");
    expect(harness.github.mutations()).toEqual([]);
  });
});

describe("approval lifecycle", () => {
  it("does not assign on an Approval that expired before it was consumed", async () => {
    await deliver("delivery-1", 41);
    const paused = await harness.triage({ deliveryId: "delivery-1", issueNumber: 41 });
    await harness.approve(paused.pendingApprovalId as string);

    harness.advanceClock(2 * 60 * 60 * 1000);
    const resumed = await harness.resume(paused);

    expect(resumed.outcome).toBe("blocked");
    expect(resumed.blockedReason).toBe("expired");
    expect(harness.github.issue(41).assignees).toEqual([]);
  });

  it("does not assign on an Approval that was revoked after being granted", async () => {
    await deliver("delivery-1", 41);
    const paused = await harness.triage({ deliveryId: "delivery-1", issueNumber: 41 });
    await harness.approve(paused.pendingApprovalId as string);
    await harness.approvals.revoke(
      harness.businessId,
      paused.pendingApprovalId as string,
      harness.now()
    );

    const resumed = await harness.resume(paused);

    expect(resumed.outcome).toBe("blocked");
    expect(resumed.blockedReason).toBe("revoked");
    expect(harness.github.issue(41).assignees).toEqual([]);
  });

  it("spends an Approval exactly once even if the resume is replayed", async () => {
    await deliver("delivery-1", 41);
    const paused = await harness.triage({ deliveryId: "delivery-1", issueNumber: 41 });
    await harness.approve(paused.pendingApprovalId as string);

    const first = await harness.resume(paused);
    const replayed = await harness.resume(paused);

    expect(first.outcome).toBe("completed");
    expect(replayed.blockedReason).toBe("already_used");
    expect(harness.github.issue(41).assignees).toEqual(["maya-dev"]);
    expect(harness.github.comments(41)).toHaveLength(1);
  });
});

describe("cancellation", () => {
  it("stops before the next external mutation when the Run is cancelled", async () => {
    await deliver("delivery-1", 41);
    harness.cancelAfter("ApplyLabels");

    const result = await harness.triage({ deliveryId: "delivery-1", issueNumber: 41 });

    expect(result.outcome).toBe("cancelled");
    expect(harness.jira.issues()).toHaveLength(0);
    expect(harness.github.issue(41).assignees).toEqual([]);
    expect(harness.github.issue(41).state).toBe("open");
  });
});
