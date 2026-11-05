import { createHash, randomUUID } from 'node:crypto';
import { Context } from '@temporalio/activity';
import {
  planDocumentDiagrams,
  planDocumentObjectPath,
  planDocumentPdfLimit,
  renderPlanDocumentHtml,
  type PlanDocumentRenderJob,
  type PlanDocumentRenderResult,
  type PlanDocumentStoredObject,
} from '@tulipfarm/plan-documents';
import type { ObjectWriter } from './objects.ts';
import type { Renderer } from './render.ts';

/** Draws a plan document's diagrams, lays out its page and prints it. Needs no database. */
export async function renderDocument(renderer: Renderer, job: PlanDocumentRenderJob) {
  const diagrams = planDocumentDiagrams(job.model);
  const diagramSvgs = await renderer.diagrams(diagrams);
  const html = renderPlanDocumentHtml(job.model, { diagramSvgs, stamp: job.stamp, timeZone: job.timeZone });
  const pdf = await renderer.pdf(html);
  return { html, pdf, undrawn: diagrams.filter(diagram => !diagramSvgs[diagram.key]).map(diagram => diagram.key) };
}

export function createRenderActivities(renderer: Renderer, objects: ObjectWriter) {
  async function store(workspaceId: string, body: Uint8Array, contentType: string): Promise<PlanDocumentStoredObject> {
    const key = randomUUID();
    await objects.putIfAbsent(planDocumentObjectPath(workspaceId, key), body, contentType);
    return { key, size: body.byteLength, sha256: createHash('sha256').update(body).digest('hex') };
  }
  return {
    async renderPlanDocument(job: PlanDocumentRenderJob): Promise<PlanDocumentRenderResult> {
      const context = Context.current();
      const beat = setInterval(() => context.heartbeat(), 10000);
      try {
        const drawn = await renderDocument(renderer, job);
        const html = await store(job.workspaceId, Buffer.from(drawn.html, 'utf8'), 'text/html; charset=utf-8');
        const pdf =
          drawn.pdf.byteLength > planDocumentPdfLimit
            ? null
            : await store(job.workspaceId, drawn.pdf, 'application/pdf');
        return { html, pdf, undrawn: drawn.undrawn };
      } finally {
        clearInterval(beat);
      }
    },
  };
}
