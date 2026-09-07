import { randomUUID } from "node:crypto";
import { DurableWaitManager, RunResumeGateway } from "@tulipfarm/run-kernel";
import { canonicalHash } from "@tulipfarm/schema";
import {
  ambientTransactionPort,
  type Queryable,
  RunStore,
  type TransactionPort,
  WaitStore,
} from "@tulipfarm/storage";
import {
  type ApprovalSignalOutcome,
  ApprovalsRepo,
  listPendingRoutineApprovals,
} from "@tulipfarm/tool-host";
import type { RoutineApprovalPayload } from "../internal/routine-approval-host";

export interface RoutineApprovalServiceOptions {
  readonly transactions: TransactionPort;
  newId?(): string;
  now?(): Date;
}

function payloadOf(row: { payload: unknown }): Partial<RoutineApprovalPayload> {
  return typeof row.payload === "object" && row.payload !== null
    ? (row.payload as Partial<RoutineApprovalPayload>)
    : {};
}

export class RoutineApprovalService {
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(private readonly options: RoutineApprovalServiceOptions) {
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async listPendingFor(input: { businessId: string; roles: readonly string[] }) {
    return this.options.transactions.withTransaction((transaction) => {
      const { repo, waits } = transactionServices(transaction);
      return listPendingRoutineApprovals(repo, waits, input);
    });
  }

  async signal(input: {
    businessId: string;
    approvalId: string;
    decision: "approved" | "denied";
    /** Who is deciding, for the audit trail and for the kernel's own principal check. */
    principal: string;
    /** Every role that principal holds; membership in one the wait allows is what authorizes. */
    roles: readonly string[];
  }): Promise<ApprovalSignalOutcome> {
    return this.options.transactions.withTransaction(async (transaction) => {
      const { repo, waits } = transactionServices(transaction);
      const row = await repo.findById(input.approvalId);
      if (row === null || row.kind !== "routine_state") return "not_found";
      const { waitId, runId, resumeToken } = payloadOf(row);
      if (waitId === undefined || runId === undefined || resumeToken === undefined) {
        return "not_found";
      }

      const wait = await waits.find(input.businessId, waitId);
      if (wait === null) return "not_found";
      const held = new Set(input.roles.map((role) => `role:${role}`));
      const asRole = wait.allowedPrincipals.find((allowed) => held.has(allowed));
      if (asRole === undefined) return "forbidden";

      let decidedBy = row.approverPrincipalId;
      if (row.status === "pending") {
        if (!(await repo.settlePending(input.approvalId, input.decision, input.principal))) {
          return "already_settled";
        }
        decidedBy = input.principal;
      } else if (row.status !== input.decision) {
        return "already_settled";
      }

      const result = await waits.signal({
        id: this.newId(),
        businessId: input.businessId,
        runId,
        token: resumeToken,
        // The wait authorizes the role; the evidence records the person who exercised it.
        principal: asRole,
        // A decision must declare the wait's schema, not this process's local signal shape.
        schemaRef: wait.schemaRef,
        // One decision per approval: a replayed request redeems nothing a second time.
        correlationKey: `approval:${input.approvalId}`,
        signalDigest: canonicalHash({
          approvalId: input.approvalId,
          decision: input.decision,
          decidedBy,
        }),
        receivedAt: this.now().toISOString(),
      });
      if (result.outcome === "duplicate") {
        await waits.resumeIfUnblocked(input.businessId, runId);
      }
      return "resumed";
    });
  }
}

function transactionServices(transaction: Queryable) {
  const transactions = ambientTransactionPort(transaction);
  const runs = new RunStore(transactions);
  return {
    repo: new ApprovalsRepo(transaction),
    waits: new DurableWaitManager(new WaitStore(transactions), new RunResumeGateway(runs)),
  };
}
