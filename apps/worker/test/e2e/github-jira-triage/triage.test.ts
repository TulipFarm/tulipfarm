import { beforeEach, describe, expect, it } from "vitest";
import { createTriageHarness, type TriageHarness } from "./harness";

/**
 * AW-064 — GitHub issue triage vertical slice.
 *
 * One flow end to end: a signed GitHub delivery becomes a persisted event, the Agent reasons over
 * the issue and its duplicate candidates, and the Routine performs every external mutation through
 * the Tool Broker — labels, a Jira ticket, an assignment behind an Approval, a reply, and a close
 * that only ever happens on the duplicate path with two approvers. The evidence a reviewer needs
 * (citations, effect states, provider state) is asserted here rather than described.
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
  harness.github.seedIssue({
    number: 12,
    title: "CSV upload returns 500",
    body: "Large CSV uploads fail.",
    author: "octo-reporter",
  });
});

async function deliver(deliveryId: string, issueNumber: number) {
  const ingress = await harness.ingest(harness.signedDelivery({ deliveryId, issueNumber }));
  expect(ingress).toMatchObject({ status: 202, outcome: "accepted" });
  return ingress;
}

describe("new issue triage", () => {
  beforeEach(() => {
    harness.classify({
      duplicate: false,
      labels: ["bug", "area:uploads"],
      summary: "Large CSV upload returns 500",
      reply: "Thanks — tracked internally and assigned.",
      candidateAccountIds: ["acct-maya", "acct-lee"],
    });
  });

  it("labels, files a Jira ticket, and pauses for approval before assigning", async () => {
    await deliver("delivery-1", 41);
    const result = await harness.triage({ deliveryId: "delivery-1", issueNumber: 41 });

    expect(result.outcome).toBe("awaiting_approval");
    expect(result.steps.map((step) => step.state)).toEqual([
      "ReadIssue",
      "FindDuplicates",
      "ClassifyIssue",
      "RouteOutcome",
      "ApplyLabels",
      "CheckAvailability",
      "CreateTicket",
      "ApproveAssignment",
    ]);
    expect(harness.github.issue(41).labels).toEqual(["bug", "area:uploads"]);
    expect(harness.jira.issues()).toHaveLength(1);
    // The assignment has not happened, and nothing was closed on the way here.
    expect(harness.github.issue(41).assignees).toEqual([]);
    expect(harness.github.issue(41).state).toBe("open");
  });

  it("assigns and replies once an eligible approver decides", async () => {
    await deliver("delivery-1", 41);
    const paused = await harness.triage({ deliveryId: "delivery-1", issueNumber: 41 });
    const approvalId = paused.pendingApprovalId as string;

    await harness.approve(approvalId);
    const resumed = await harness.resume(paused);

    expect(resumed.outcome).toBe("completed");
    expect(harness.github.issue(41).assignees).toEqual(["maya-dev"]);
    expect(harness.github.comments(41)).toHaveLength(1);
    expect(harness.github.issue(41).state).toBe("open");
  });

  it("carries exact citations for the provider state it acted on", async () => {
    await deliver("delivery-1", 41);
    const paused = await harness.triage({ deliveryId: "delivery-1", issueNumber: 41 });
    await harness.approve(paused.pendingApprovalId as string);
    const resumed = await harness.resume(paused);

    expect(resumed.citations).toContain("github:issue:tulip/farm#41");
    expect(resumed.citations).toContain(`jira:issue:${harness.jira.issues()[0]?.key}`);
    expect(resumed.citations.some((ref) => ref.startsWith("github:comment:"))).toBe(true);
  });

  it("records one durable effect per external mutation, all confirmed", async () => {
    await deliver("delivery-1", 41);
    const paused = await harness.triage({ deliveryId: "delivery-1", issueNumber: 41 });
    await harness.approve(paused.pendingApprovalId as string);
    await harness.resume(paused);

    const effects = await harness.effects.list(harness.businessId);
    expect(effects.map((effect) => effect.intent.action)).toEqual([
      "github.issue.label",
      "jira.issue.create",
      "github.issue.assign",
      "github.issue.comment",
    ]);
    expect(effects.every((effect) => effect.state === "confirmed")).toBe(true);
    expect(new Set(effects.map((effect) => effect.idempotencyKey)).size).toBe(effects.length);
  });

  it("keeps the leased credential out of every durable record", async () => {
    await deliver("delivery-1", 41);
    const paused = await harness.triage({ deliveryId: "delivery-1", issueNumber: 41 });
    await harness.approve(paused.pendingApprovalId as string);
    const resumed = await harness.resume(paused);

    const written = JSON.stringify({
      steps: resumed.steps,
      citations: resumed.citations,
      effects: await harness.effects.list(harness.businessId),
      approvals: await harness.approvals.list(harness.businessId),
    });
    expect(written).not.toContain(harness.githubCredential);
    expect(written).not.toContain(harness.jiraCredential);
  });
});

describe("duplicate issue triage", () => {
  beforeEach(() => {
    harness.classify({
      duplicate: true,
      duplicateOfIssue: 12,
      labels: ["duplicate"],
      summary: "Duplicate of #12",
      reply: "Closing as a duplicate of #12.",
      candidateAccountIds: [],
    });
  });

  it("replies and closes only after two approvers decide the high-risk close", async () => {
    await deliver("delivery-2", 41);
    const paused = await harness.triage({ deliveryId: "delivery-2", issueNumber: 41 });

    expect(paused.steps.map((step) => step.state)).toEqual([
      "ReadIssue",
      "FindDuplicates",
      "ClassifyIssue",
      "RouteOutcome",
      "ReplyDuplicate",
      "ApproveClose",
    ]);
    expect(harness.github.issue(41).state).toBe("open");

    await harness.approve(paused.pendingApprovalId as string);
    const resumed = await harness.resume(paused);

    expect(resumed.outcome).toBe("completed");
    expect(harness.github.issue(41).state).toBe("closed");
    expect(resumed.citations).toContain("github:issue:tulip/farm#12");
  });

  it("refuses to close when only one approver has decided", async () => {
    await deliver("delivery-2", 41);
    const paused = await harness.triage({ deliveryId: "delivery-2", issueNumber: 41 });

    await harness.approve(paused.pendingApprovalId as string, ["principal-approver-a"]);
    const resumed = await harness.resume(paused);

    expect(resumed.outcome).toBe("blocked");
    expect(resumed.blockedReason).toBe("insufficient_approvals");
    expect(harness.github.issue(41).state).toBe("open");
  });
});

describe("ingress and partial-failure recovery", () => {
  beforeEach(() => {
    harness.classify({
      duplicate: false,
      labels: ["bug"],
      summary: "Large CSV upload returns 500",
      reply: "Thanks — tracked internally.",
      candidateAccountIds: ["acct-maya"],
    });
  });

  it("refuses an unsigned delivery without persisting an event", async () => {
    const delivery = harness.signedDelivery({ deliveryId: "delivery-3", issueNumber: 41 });
    const forged = {
      ...delivery,
      headers: { ...delivery.headers, "x-hub-signature-256": "sha256=00" },
    };

    expect(await harness.ingest(forged)).toMatchObject({ status: 401, code: "signature_invalid" });
    expect(harness.acceptedEvents).toHaveLength(0);
  });

  it("resumes the flow after reconciling an ambiguous Jira write", async () => {
    harness.jira.applyThenFail("POST /rest/api/3/issue", 503);
    await deliver("delivery-4", 41);

    const interrupted = await harness.triage({ deliveryId: "delivery-4", issueNumber: 41 });
    expect(interrupted.outcome).toBe("blocked");
    const ticketStep = interrupted.steps.find((step) => step.state === "CreateTicket");
    expect(ticketStep?.status).toBe("ambiguous");

    const reconciled = await harness.reconcile(ticketStep?.effectId as string);
    expect(reconciled.outcome).toBe("confirmed");
    // Reconciliation resolved the write that already landed — it did not create a second ticket.
    expect(harness.jira.issues()).toHaveLength(1);

    const resumed = await harness.resume(interrupted);
    expect(resumed.outcome).toBe("awaiting_approval");
  });
});
