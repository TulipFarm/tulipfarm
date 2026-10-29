import { z } from 'zod';
import {
  layoutFromReply,
  layoutPromptSnippet,
  layoutText,
  replyRenderInputSchema,
  type ReplyRenderInput,
} from '@tulipfarm/conversations/layout-contracts';
import type { NativeTool } from './native-tools.ts';

export const replyRenderToolName = 'reply_render';
/** Checks run on a placeholder surface ID; the runtime sets the reply's message ID when it saves the layout. */
const checkSurfaceId = '00000000-0000-4000-8000-000000000000';
const maxCanvasText = 300;
const maxListItem = 90;
const maxTableCell = 80;
const canvasVisuals = new Set([
  'Metric',
  'Chart',
  'Table',
  'Card',
  'Tabs',
  'Callout',
  'Badge',
  'Progress',
  'List',
  'Details',
]);

export const replyRenderTool: NativeTool = {
  name: replyRenderToolName,
  description:
    'Give your final answer as a layout of approved components. Call it alone, once all other work is done. It ends your reply.',
  parameters: z.toJSONSchema(replyRenderInputSchema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >,
};

/** The generative-UI rules. The text is fixed, so provider prompt caches still hit. */
export const generativeUiPrompt = [
  '# Answer format',
  `- Give every final answer by calling ${replyRenderToolName}, alone, after all other work. Do not also write the answer as text.`,
  '- `summary` is one or two plain sentences that answer the question. `title` names the reply in a few words.',
  '- `placement` is "chat" for a short answer or a compact visual: at most about one screen, at most two charts, and small tables. A single fact is one Text component, optionally with a Metric.',
  '- `placement` is "canvas" when the user asks for a report, document, dashboard or detailed view, or the content is longer: several sections, more than two charts or large tables.',
  '- An explicit request decides: "show it here" means chat, "open it in Canvas" means canvas.',
  '- Use numbers you got from tools or the user. Never invent data for a chart, table or metric. Say when a reading was taken.',
  '- Rows, cards and calendar events that already have their own card in the chat are not repeated. Reference an existing card with Embed and the ID from its tool result.',
  '- A Text component holds GitHub-flavored Markdown. Prefer Table and Chart components to Markdown tables and lists of numbers.',
  '- When a Chart plots values on a fixed scale, set its max to the top of that scale, such as 10 for scores out of 10 or 100 for percentages.',
  '- If the tool returns errors, fix them and call it again.',
  '',
  '# Canvas reports',
  'A canvas report is a designed one-page brief that a busy reader scans in under a minute, not an essay. Lead with the answer, then the evidence.',
  'Build it in this order:',
  '1. A level 1 Heading that names the decision or topic.',
  '2. A Callout with tone "success" or "info": a title with the answer or recommendation, and one or two sentences of why.',
  '3. A Row of 3 or 4 Metric components. Each shows a different headline fact or verdict, such as "Best default: Valkey" or "Lowest cost: Memcached". Do not show near-identical scores side by side.',
  '4. One Chart that carries the main comparison, with a short title and max set for fixed scales.',
  '5. A Row of one Card per option or topic. The Card title names it and its description is a short tagline. Inside: one Badge with its verdict, then a "Strengths" Text and a List, and a "Watch out for" Text and a List.',
  '6. A Table only for facts not already shown, such as setup, pricing or licensing. Cells are short phrases, not sentences.',
  '7. Details for method, assumptions and caveats, so they start collapsed.',
  'Rules:',
  '- Show each fact once. Do not repeat chart values in Metrics or a Table, or Table rows in Cards.',
  '- A Chart of scores out of 10 sets max to 10 and no unit.',
  `- A List has at most 3 items. Each item is a short phrase of at most ${maxListItem} characters, without a label such as "Strengths:".`,
  `- Table cells hold at most ${maxTableCell} characters. A Text never contains a Markdown heading and holds at most ${maxCanvasText} characters.`,
  '',
  'Layout reference:',
  layoutPromptSnippet(),
].join('\n');

export type ReplyRender = { ok: true; input: ReplyRenderInput; text: string } | { ok: false; error: string };

/** Report design problems in a canvas layout: text walls, long lists and cells, Markdown headings and too few visual components. */
export function canvasDesignErrors(input: ReplyRenderInput): string[] {
  if (input.placement !== 'canvas') return [];
  const components = input.messages.flatMap(message =>
    'updateComponents' in message ? (message.updateComponents.components as Record<string, unknown>[]) : [],
  );
  const errors: string[] = [];
  for (const component of components) {
    if (component.component !== 'Text' || typeof component.text !== 'string') continue;
    if (/^\s{0,3}#{1,6}\s/mu.test(component.text))
      errors.push(`${String(component.id)}: Text contains a Markdown heading. Use a Heading or Section title.`);
    if (component.text.length > maxCanvasText)
      errors.push(
        `${String(component.id)}: Text has ${component.text.length} characters. Keep each Text under ${maxCanvasText}; turn the content into Metric, Table, Card, List or Details components.`,
      );
  }
  const byId = new Map(components.map(component => [component.id, component]));
  for (const component of components) {
    if (component.component === 'List' && Array.isArray(component.children)) {
      if (component.children.length > 3)
        errors.push(`${String(component.id)}: List has ${component.children.length} items. Keep the best 3.`);
      for (const id of component.children) {
        const item = byId.get(id);
        if (item?.component === 'Text' && typeof item.text === 'string' && item.text.length > maxListItem)
          errors.push(
            `${String(item.id)}: List item has ${item.text.length} characters. Shorten it to a phrase of at most ${maxListItem}.`,
          );
      }
    }
    if (component.component === 'Table' && Array.isArray(component.rows)) {
      const long = (component.rows as unknown[]).flatMap(row =>
        row && typeof row === 'object'
          ? Object.values(row).filter(cell => typeof cell === 'string' && cell.length > maxTableCell)
          : [],
      );
      if (long.length)
        errors.push(
          `${String(component.id)}: ${long.length} Table cells are longer than ${maxTableCell} characters. Use short phrases.`,
        );
    }
  }
  const scores = components.filter(
    component =>
      component.component === 'Metric' &&
      typeof component.value === 'string' &&
      /^\s*\d+(\.\d+)?\s*\/\s*\d+\s*$/u.test(component.value),
  );
  if (scores.length > 1 && components.some(component => component.component === 'Chart'))
    errors.push(
      `${scores.map(metric => String(metric.id)).join(', ')}: these Metrics repeat scores the Chart already shows. Make each Metric a different verdict, such as "Best default: Valkey".`,
    );
  const visuals = new Set(
    components.map(component => String(component.component)).filter(name => canvasVisuals.has(name)),
  );
  if (visuals.size < 3)
    errors.push(
      `The report uses ${visuals.size} kinds of visual component. Use at least three of: ${[...canvasVisuals].join(', ')}.`,
    );
  return errors;
}

/**
 * Checks a `reply_render` call. On success `text` is the reply's plain text, used for previews and the completion check.
 * With `design`, a canvas layout that reads as a text wall is rejected so the model rebuilds it once.
 */
export function parseReplyRender(input: unknown, options: { design?: boolean } = {}): ReplyRender {
  const parsed = replyRenderInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: `Invalid layout: ${z.prettifyError(parsed.error)}` };
  const checked = layoutFromReply(parsed.data, checkSurfaceId);
  if (!checked.ok)
    return {
      ok: false,
      error: `Invalid layout. Fix these and call ${replyRenderToolName} again:\n${checked.errors
        .slice(0, 20)
        .map(error => `- ${error.path}: ${error.message}`)
        .join('\n')}`,
    };
  const design = options.design ? canvasDesignErrors(parsed.data) : [];
  if (design.length)
    return {
      ok: false,
      error: `This canvas report reads like a chat reply. Rebuild it as a visual report, following the Canvas reports rules, and call ${replyRenderToolName} again:\n${design
        .slice(0, 20)
        .map(error => `- ${error}`)
        .join('\n')}`,
    };
  return { ok: true, input: parsed.data, text: layoutText(checked.layout) };
}
