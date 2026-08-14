/** Verifies the supplied audit chain for tamper, reorder, deletion, fork, and anchor drift. */

import { recomputeEventHash } from "./chain";
import { type AuditEvent, AuditInputError, normalizeAuditEventInput } from "./event";

export type VerifyIssueType =
  | "tampered"
  | "reordered"
  | "missing"
  | "forked"
  | "business_mismatch"
  | "protected_payload"
  | "anchor_mismatch";

export interface VerifyIssue {
  readonly type: VerifyIssueType;
  readonly chainIndex: number;
  readonly eventIds: readonly string[];
}

export interface VerifyResult {
  readonly valid: boolean;
  readonly issues: readonly VerifyIssue[];
}

export interface VerifyExpectation {
  /** Durable event count or sealed-segment count used to detect tail/all-event deletion. */
  readonly eventCount?: number;
  /** Durable or sealed tail hash used to detect truncation or replacement of the final event. */
  readonly tailHash?: string | null;
}

function inputOf(event: AuditEvent) {
  const {
    id: _id,
    businessId: _businessId,
    chainIndex: _index,
    previousHash: _previous,
    hash: _hash,
    ...input
  } = event;
  return input;
}

/** Verifies one business chain; reports tampered, forked, missing, and reordered evidence. */
export function verifyChain(
  events: readonly AuditEvent[],
  expectation: VerifyExpectation = {}
): VerifyResult {
  const issues: VerifyIssue[] = [];
  const byIndex = new Map<number, AuditEvent[]>();
  const businessId = events[0]?.businessId;
  for (const event of events) {
    const group = byIndex.get(event.chainIndex) ?? [];
    group.push(event);
    byIndex.set(event.chainIndex, group);
    if (
      (businessId !== undefined && event.businessId !== businessId) ||
      event.businessId !== event.actor.businessId
    ) {
      issues.push({
        type: "business_mismatch",
        chainIndex: event.chainIndex,
        eventIds: [event.id],
      });
    }
    try {
      normalizeAuditEventInput(inputOf(event));
    } catch (error) {
      issues.push({
        type:
          error instanceof AuditInputError && error.code === "PROTECTED_PAYLOAD"
            ? "protected_payload"
            : "tampered",
        chainIndex: event.chainIndex,
        eventIds: [event.id],
      });
    }
  }

  for (const [chainIndex, group] of byIndex) {
    if (group.length > 1) {
      issues.push({
        type: "forked",
        chainIndex,
        eventIds: group.map((event) => event.id),
      });
    }
  }

  if (
    events.length === 0 &&
    expectation.eventCount === undefined &&
    expectation.tailHash === undefined
  ) {
    return { valid: true, issues };
  }

  const maxObservedIndex =
    events.length === 0 ? -1 : Math.max(...events.map((event) => event.chainIndex));
  const maxIndex = Math.max(maxObservedIndex, (expectation.eventCount ?? 0) - 1);
  for (let index = 0; index <= maxIndex; index += 1) {
    if (!byIndex.has(index)) {
      issues.push({ type: "missing", chainIndex: index, eventIds: [] });
    }
  }

  const sorted = [...events].sort((a, b) => a.chainIndex - b.chainIndex);
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].chainIndex !== events[index - 1].chainIndex + 1) {
      issues.push({
        type: "reordered",
        chainIndex: events[index].chainIndex,
        eventIds: [events[index].id],
      });
    }
  }
  let previous: AuditEvent | undefined;
  for (const event of sorted) {
    let recomputed: string | undefined;
    try {
      recomputed = recomputeEventHash(event);
    } catch {
      recomputed = undefined;
    }
    if (recomputed !== event.hash) {
      issues.push({ type: "tampered", chainIndex: event.chainIndex, eventIds: [event.id] });
    }
    const expectedPreviousHash = previous ? previous.hash : null;
    if (
      event.chainIndex === (previous?.chainIndex ?? -1) + 1 &&
      event.previousHash !== expectedPreviousHash
    ) {
      issues.push({ type: "reordered", chainIndex: event.chainIndex, eventIds: [event.id] });
    }
    previous = event;
  }

  if (expectation.eventCount !== undefined && events.length !== expectation.eventCount) {
    issues.push({
      type: "anchor_mismatch",
      chainIndex: expectation.eventCount,
      eventIds: [],
    });
  }
  if (expectation.tailHash !== undefined) {
    const tail = sorted.at(-1)?.hash ?? null;
    if (tail !== expectation.tailHash) {
      issues.push({
        type: "anchor_mismatch",
        chainIndex: sorted.at(-1)?.chainIndex ?? -1,
        eventIds: sorted.at(-1) ? [sorted.at(-1)?.id ?? ""] : [],
      });
    }
  }

  return { valid: issues.length === 0, issues };
}
