import { ActivityFailure, log, proxyActivities } from '@temporalio/workflow';
import type {
  PlanDocumentError,
  PlanDocumentMode,
  PlanDocumentTarget,
  PreparedPlanDocument,
} from '@tulipfarm/agents/plan-document-store';
import type { PlanDocumentRenderJob, PlanDocumentRenderResult } from '@tulipfarm/plan-documents';

type Main = {
  preparePlanDocument(
    workspaceId: string,
    planId: string,
    mode: PlanDocumentMode,
  ): Promise<PreparedPlanDocument | null>;
  failPlanDocument(
    workspaceId: string,
    planId: string,
    at: PlanDocumentTarget,
    error: PlanDocumentError,
    html?: PlanDocumentRenderResult['html'],
  ): Promise<void>;
  publishPlanDocument(
    workspaceId: string,
    planId: string,
    at: PlanDocumentTarget,
    result: PlanDocumentRenderResult & { stampTone: string },
  ): Promise<void>;
};

const main = proxyActivities<Main>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '2 seconds', maximumInterval: '1 minute', maximumAttempts: 5 },
});
const record = proxyActivities<Pick<Main, 'failPlanDocument'>>({
  startToCloseTimeout: '1 minute',
  retry: { initialInterval: '2 seconds', maximumInterval: '1 minute' },
});

/**
 * Renders a plan's current revision as a page and a PDF and files the PDF in the starter's `plans` folder. Drawing and
 * printing run on the render worker, which has a browser and no database.
 */
export async function planDocument(
  workspaceId: string,
  planId: string,
  options: { mode: PlanDocumentMode; renderQueue: string },
): Promise<void> {
  const prepared = await main.preparePlanDocument(workspaceId, planId, options.mode);
  if (!prepared) return;
  const at: PlanDocumentTarget = { revision: prepared.revision, generation: prepared.generation };
  const render = proxyActivities<{ renderPlanDocument(job: PlanDocumentRenderJob): Promise<PlanDocumentRenderResult> }>(
    {
      taskQueue: options.renderQueue,
      startToCloseTimeout: '3 minutes',
      scheduleToCloseTimeout: '30 minutes',
      heartbeatTimeout: '1 minute',
      retry: { initialInterval: '5 seconds', maximumInterval: '1 minute', maximumAttempts: 3 },
    },
  );
  let result: PlanDocumentRenderResult;
  try {
    result = await render.renderPlanDocument(prepared.job);
  } catch (error) {
    log.warn('Plan document could not be rendered', { workspaceId, planId, ...at });
    await record.failPlanDocument(workspaceId, planId, at, 'render');
    if (error instanceof ActivityFailure) return;
    throw error;
  }
  if (result.undrawn.length)
    log.info('Plan document diagrams fell back to text', { workspaceId, planId, count: result.undrawn.length });
  try {
    await main.publishPlanDocument(workspaceId, planId, at, { ...result, stampTone: prepared.job.stamp.tone });
  } catch (error) {
    log.warn('Plan document could not be filed', { workspaceId, planId, ...at });
    await record.failPlanDocument(workspaceId, planId, at, 'files', result.html);
    if (error instanceof ActivityFailure) return;
    throw error;
  }
}
