/**
 * Verifies a business's audit chain against tamper, reorder, deletion, and fork (SPEC §20, §24:
 * "audit tampering, deletion, reordering, forked chains ... " must be detectable). Takes the
 * chain as returned by {@link AuditEventRepo.listChain} — callers decide the query boundary;
 * this module only re-derives evidence from what it is given.
 */

import { recomputeEventHash } from "./chain";
import type { AuditEvent } from "./event";

export type VerifyIssueType = "tampered" | "reordered" | "missing" | "forked";

export interface VerifyIssue {
  readonly type: VerifyIssueType;
  readonly chainIndex: number;
  readonly eventIds: readonly string[];
}

export interface VerifyResult {
  readonly valid: boolean;
  readonly issues: readonly VerifyIssue[];
}

/**
 * Verifies `events` as a single business's chain, in the order given.
 *
 * - **tampered**: an event's recomputed hash does not match its recorded `hash`.
 * - **forked**: more than one event claims the same `chainIndex`.
 * - **missing**: a `chainIndex` gap (a segment was deleted).
 * - **reordered**: an event's `previousHash` does not match the preceding index's recorded hash.
 */
export function verifyChain(events: readonly AuditEvent[]): VerifyResult {
  const issues: VerifyIssue[] = [];
  const byIndex = new Map<number, AuditEvent[]>();
  for (const event of events) {
    const group = byIndex.get(event.chainIndex) ?? [];
    group.push(event);
    byIndex.set(event.chainIndex, group);
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

  if (events.length === 0) {
    return { valid: true, issues: [] };
  }

  const maxIndex = Math.max(...events.map((event) => event.chainIndex));
  for (let index = 0; index <= maxIndex; index += 1) {
    if (!byIndex.has(index)) {
      issues.push({ type: "missing", chainIndex: index, eventIds: [] });
    }
  }

  const sorted = [...events].sort((a, b) => a.chainIndex - b.chainIndex);
  let previous: AuditEvent | undefined;
  for (const event of sorted) {
    if (recomputeEventHash(event) !== event.hash) {
      issues.push({ type: "tampered", chainIndex: event.chainIndex, eventIds: [event.id] });
    }
    const expectedPreviousHash = previous ? previous.hash : null;
    if (
      previous &&
      previous.chainIndex === event.chainIndex - 1 &&
      event.previousHash !== expectedPreviousHash
    ) {
      issues.push({ type: "reordered", chainIndex: event.chainIndex, eventIds: [event.id] });
    }
    previous = event;
  }

  return { valid: issues.length === 0, issues };
}
