import type { OimKnowledgeSyncOptions } from "@tulipfarm/integrations";
import { canonicalHash } from "@tulipfarm/schema";
import type {
  OimKnowledgeCheckpointStore,
  OimKnowledgeSubscriptionStore,
} from "@tulipfarm/storage";

interface SyncOutcome {
  readonly failures: readonly { readonly code: string }[];
}

export async function runSubscribedKnowledgeSync(
  options: OimKnowledgeSyncOptions,
  deps: {
    readonly subscriptions: Pick<OimKnowledgeSubscriptionStore, "list" | "recordAttempt">;
    readonly checkpoints: Pick<OimKnowledgeCheckpointStore, "load">;
    readonly now: () => Date;
    readonly sync: (assertSelected: () => Promise<void>) => Promise<SyncOutcome>;
  }
): Promise<SyncOutcome> {
  const selected = (await deps.subscriptions.list(options.businessId, options.connectionId)).find(
    (entry) => entry.sourceKindId === options.sourceKindId
  );
  if (!selected?.enabled || canonicalHash(selected.scopes) !== canonicalHash(options.scopes)) {
    return { failures: [] };
  }
  const assertSelected = async () => {
    const current = (
      await deps.subscriptions.list(selected.businessId, selected.connectionId)
    ).find((entry) => entry.sourceKindId === selected.sourceKindId);
    if (!current?.enabled || current.revision !== selected.revision) {
      throw new Error("knowledge_subscription_changed");
    }
  };
  try {
    const result = await deps.sync(assertSelected);
    const checkpoints = await Promise.all(
      selected.scopes.map((scope) =>
        deps.checkpoints.load({
          businessId: selected.businessId,
          connectionId: selected.connectionId,
          integrationId: selected.integrationId,
          integrationMajorVersion: selected.integrationMajorVersion,
          sourceKind: selected.sourceKindId,
          scope,
        })
      )
    );
    await deps.subscriptions.recordAttempt(
      selected,
      result.failures.map(({ code }) => code),
      checkpoints.every((checkpoint) => checkpoint !== null && checkpoint.scanId === null),
      deps.now()
    );
    return result;
  } catch (error) {
    await deps.subscriptions.recordAttempt(selected, ["sync_failed"], false, deps.now());
    throw error;
  }
}
