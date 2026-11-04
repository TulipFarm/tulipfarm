import { planGraphMermaid } from './graph.ts';
import type { PlanDocumentModel } from './model.ts';
import type { PlanStamp } from './stamp.ts';

/** The PDF limit (P38). A larger PDF is not saved; the HTML still is. */
export const planDocumentPdfLimit = 10 * 1024 * 1024;

/** The task queue the render worker polls, beside the main `TEMPORAL_TASK_QUEUE`. */
export const planDocumentRenderQueue = (env: NodeJS.ProcessEnv = process.env) =>
  `${env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm'}-render`;

/** Where a rendered HTML page or PDF of a workspace's plan document is kept in the files bucket. */
export const planDocumentObjectPath = (workspaceId: string, key: string) => `${workspaceId}/plan-documents/${key}`;

/** What the render worker draws and prints. Everything it needs travels here, so it needs no database. */
export type PlanDocumentRenderJob = {
  workspaceId: string;
  model: PlanDocumentModel;
  stamp: PlanStamp;
  timeZone: string;
};

export type PlanDocumentStoredObject = { key: string; size: number; sha256: string };

export type PlanDocumentRenderResult = {
  html: PlanDocumentStoredObject;
  /** Null when the PDF would be larger than `planDocumentPdfLimit`. */
  pdf: PlanDocumentStoredObject | null;
  /** Diagrams that couldn't be drawn and show their fallback. */
  undrawn: string[];
};

/** The Mermaid sources a document draws, by key: `plan` for the plan graph, then the written diagrams. */
export function planDocumentDiagrams(model: PlanDocumentModel): { key: string; source: string }[] {
  return [
    ...(model.tasks.some(task => task.kind === 'work') ? [{ key: 'plan', source: planGraphMermaid(model.tasks) }] : []),
    ...model.sections.diagrams.map(diagram => ({ key: diagram.key, source: diagram.mermaid })),
  ];
}
