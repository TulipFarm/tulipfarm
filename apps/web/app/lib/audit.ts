/** Audit reads are hash-chained evidence, not the cosmetic ActivityService feed. */

import { apiGet } from "./api";

export type AuditEvent = {
  id: string;
  chainIndex: number;
  previousHash: string | null;
  hash: string;
  actorPrincipalId: string;
  effectivePrincipalId: string;
  action: string;
  target: string;
  decision: string;
  reasonCodes: string[];
  correlationId: string;
  occurredAt: string;
  agentId: string | null;
  runId: string | null;
  safeMetadata: Record<string, unknown> | null;
};

export type AuditEventPage = {
  items: AuditEvent[];
  /** `chainIndex` of the last row returned, or null at the end of the ledger. */
  nextCursor: number | null;
};

export type AuditVerifyReport = {
  valid: boolean;
  eventCount: number;
  tailHash: string | null;
  checkedAt: string;
  issues: Array<{ type: string; chainIndex: number; eventIds: string[] }>;
};

export function listAuditEvents(cursor?: number, limit = 25): Promise<AuditEventPage> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor !== undefined && cursor !== null) query.set("cursor", String(cursor));
  return apiGet<AuditEventPage>(`/api/v1/audit/events?${query}`);
}

export function verifyAuditChain(): Promise<AuditVerifyReport> {
  return apiGet<AuditVerifyReport>("/api/v1/audit/verify");
}
