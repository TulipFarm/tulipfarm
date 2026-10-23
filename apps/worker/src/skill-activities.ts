import { z } from 'zod';
import { currentMember, lockAuthorization, sourceDependenciesSchema, type HumanActor } from '@tulipfarm/access';
import { requireDraftSources } from '@tulipfarm/agents/draft-sources';
import { calculateUsageCost, estimateInputTokens, reserveModelCost, usageTokenCounts } from '@tulipfarm/config';
import { recordUsage } from '@tulipfarm/extensions';
import { CreditAttemptAlreadyDispatched, reserveCredits, settleCredits } from '@tulipfarm/workspace-storage/credits';
import type { ConversationRuntime } from '@tulipfarm/conversations/runtime';
import type { FileBytes } from '@tulipfarm/files';
import { createSkillObjects, skillPackageCompatibility } from '@tulipfarm/agents/skill-objects';
import { createSkillImports } from '@tulipfarm/agents/skill-imports';
import { skillSafetyReportSchema } from '@tulipfarm/agents/skill-import-contracts';
import { skillSafetySystem, type SkillSafetyReviewer } from '@tulipfarm/agents/skill-package-review';
import { inferWithSystem } from '@tulipfarm/agents/inference';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { roleModel } from './conversation-model.ts';

export function meteredSkillReviewer(
  runtime: ConversationRuntime,
  workspaceId: string,
  actor: HumanActor,
  importId: string,
): SkillSafetyReviewer {
  return async input => {
    const model = roleModel('review');
    if (!model) throw new Error('skill-review-model-unavailable');
    const { route, price } = model;
    const text = await inferWithSystem(
      { ...route, maxOutputTokens: price.maxOutputTokens },
      skillSafetySystem,
      [{ role: 'user', text: JSON.stringify({ files: input.files, unreviewedFiles: input.unreviewedFiles }) }],
      async ({ inputBytes, maxOutputTokens }) => {
        const quote = {
          modelId: price.modelId,
          pricingRevision: price.pricingRevision,
          rates: price.rates,
          maxInputTokens: Math.min(inputBytes + 4096, price.maxInputTokens),
          maxOutputTokens,
          date: new Date().toISOString().slice(0, 10),
        };
        if (estimateInputTokens(inputBytes) + 4096 > price.maxInputTokens)
          throw new Error('skill-review-context-limit');
        const attempt = `skill-review:${importId}:${input.id}`;
        const admitted = await runtime.transaction(workspaceId, skillPackageCompatibility, async tx => {
          await lockAuthorization(tx);
          await currentMember(tx, actor);
          const live = await tx.client.query(
            `SELECT sources FROM ${qualified(tx.schema, 'tf_skill_imports')} WHERE id=$1 AND membership_id=$2 AND status='reviewing' AND expires_at>now()`,
            [importId, actor.membershipId],
          );
          if (!live.rowCount) throw new Error('skill-review-cancelled');
          await requireDraftSources(tx, actor, sourceDependenciesSchema.parse(live.rows[0]?.sources));
          return reserveCredits(tx, {
            id: attempt,
            flowId: importId,
            modelId: price.modelId,
            agentId: null,
            activity: 'other',
            providerPicoUsd: reserveModelCost(quote),
            pricingRevision: quote.pricingRevision,
          });
        });
        if (!admitted) throw new CreditAttemptAlreadyDispatched();
        return async usage => {
          if (usage.kind !== 'known') return;
          const { kind, ...tokens } = usage;
          const cost = calculateUsageCost({ ...quote, usage: { kind, tokens } });
          if (cost.kind !== 'known') return;
          await runtime.transaction(workspaceId, skillPackageCompatibility, tx =>
            settleCredits(tx, attempt, cost.providerPicoUsd),
          );
          void recordUsage({
            workspaceId,
            flowId: importId,
            modelId: price.modelId,
            agentId: null,
            activity: 'other',
            ...usageTokenCounts(tokens),
            providerPicoUsd: cost.providerPicoUsd,
            at: new Date(),
          });
        };
      },
    );
    return skillSafetyReportSchema.shape.ai.parse(JSON.parse(text));
  };
}

export function createSkillActivities(
  runtime: ConversationRuntime,
  bytes: FileBytes,
  runtimeAvailable: () => boolean | Promise<boolean>,
) {
  const imports = createSkillImports(runtime, {
    objects: createSkillObjects(runtime, bytes),
    review: (workspaceId, actor, importId) => meteredSkillReviewer(runtime, workspaceId, actor, importId),
    runtimeAvailable,
  });
  return {
    prepareSkillImport: (workspaceId: string, importId: string) =>
      imports.process(z.uuid().parse(workspaceId), z.uuid().parse(importId)),
  };
}
