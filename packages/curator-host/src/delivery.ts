import {
  type CuratorCitation,
  curatorDedupeKey,
  PROPOSAL_KINDS,
  PROPOSAL_SUBJECT_KIND,
  type ProposalDelivery,
  type ProposalKind,
  templateProposal,
} from "@tulipfarm/curator";
import {
  type CuratorProposalTaskEffect,
  type CuratorRepo,
  type TaskStore,
  TaskStoreError,
} from "@tulipfarm/storage";

const DELIVERY_LIMIT = 25;
const APPLY_LEASE_MS = 5 * 60_000;

export interface CuratorTaskDeliveryDeps {
  readonly repo: CuratorRepo;
  readonly tasks: TaskStore;
  now(): Date;
}

export interface CuratorTaskDeliveryResult {
  readonly delivered: number;
  readonly retryableFailed: number;
  readonly terminalRejected: number;
}

interface ProposalPayload {
  readonly proposalKind: ProposalKind;
  readonly subjectId: string;
  readonly subjectLabel: string;
  readonly deliver: readonly ProposalDelivery[];
  readonly dedupeKey: string;
  readonly rationale: string;
  readonly citations: readonly CuratorCitation[];
}

/**
 * Delivers the narrowly approved Curator pilot: server-templated Proposals as direct-user Tasks.
 *
 * Task creation is intentionally outside the model and idempotent on the reserved dedupe key. A
 * crash after the Task upsert but before effect settlement retries the same upsert and leaves one
 * Task. Everything other than a Proposal that explicitly requests Task delivery remains shadowed.
 */
export class CuratorTaskDelivery {
  constructor(private readonly deps: CuratorTaskDeliveryDeps) {}

  async run(businessId: string, limit = DELIVERY_LIMIT): Promise<CuratorTaskDeliveryResult> {
    const now = this.deps.now();
    const effects = await this.deps.repo.claimProposalTasks({
      businessId,
      limit,
      staleBefore: new Date(now.getTime() - APPLY_LEASE_MS),
    });
    let delivered = 0;
    let retryableFailed = 0;
    let terminalRejected = 0;

    for (const effect of effects) {
      const proposal = proposalPayload(effect);
      if (!proposal) {
        if (await this.deps.repo.rejectProposalTask(effect.id)) terminalRejected += 1;
        continue;
      }
      const template = templateProposal({
        kind: proposal.proposalKind,
        subjectId: proposal.subjectId,
        subjectLabel: proposal.subjectLabel,
      });
      try {
        const task = await this.deps.tasks.upsertOpen(
          {
            businessId: effect.businessId,
            assigneeKind: "user",
            assigneeId: effect.userId,
            dedupeKey: proposal.dedupeKey,
            title: template.title,
            detail: template.detail,
            action: template.action,
            subject: {
              kind: PROPOSAL_SUBJECT_KIND[proposal.proposalKind],
              id: proposal.subjectId,
            },
          },
          now
        );
        if (
          await this.deps.repo.completeProposalTask({
            effectId: effect.id,
            taskId: task.id,
            kind: proposal.proposalKind,
            deliver: proposal.deliver,
            citations: proposal.citations,
            rationale: proposal.rationale,
          })
        ) {
          delivered += 1;
        }
      } catch (error) {
        if (error instanceof TaskStoreError && error.code === "dismissed_permanently") {
          if (await this.deps.repo.rejectProposalTask(effect.id)) terminalRejected += 1;
        } else if (await this.deps.repo.retryProposalTask(effect.id)) {
          retryableFailed += 1;
        }
      }
    }
    return { delivered, retryableFailed, terminalRejected };
  }
}

function proposalPayload(effect: CuratorProposalTaskEffect): ProposalPayload | undefined {
  const payload = effect.payload as Partial<ProposalPayload> | null;
  if (!payload || typeof payload !== "object") return undefined;
  if (!PROPOSAL_KINDS.includes(payload.proposalKind as ProposalKind)) return undefined;
  if (typeof payload.subjectId !== "string" || typeof payload.subjectLabel !== "string") {
    return undefined;
  }
  if (!Array.isArray(payload.deliver) || !payload.deliver.includes("task")) return undefined;
  if (typeof payload.rationale !== "string" || !Array.isArray(payload.citations)) return undefined;
  const proposalKind = payload.proposalKind as ProposalKind;
  if (payload.dedupeKey !== curatorDedupeKey(proposalKind, payload.subjectId)) return undefined;
  return {
    proposalKind,
    subjectId: payload.subjectId,
    subjectLabel: payload.subjectLabel,
    deliver: payload.deliver as ProposalDelivery[],
    dedupeKey: payload.dedupeKey,
    rationale: payload.rationale,
    citations: payload.citations as CuratorCitation[],
  };
}
