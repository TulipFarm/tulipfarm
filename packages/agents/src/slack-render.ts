import { z } from 'zod';
import {
  layoutFromReply,
  layoutText,
  slackLayoutSchema,
  followUpAction,
  layoutSurfaceCatalogId,
  layoutVersion,
  type ReplyRenderInput,
} from '@tulipfarm/conversations/layout-contracts';
import { slackModalView } from '@tulipfarm/slack';
import { parseSlackSurface, SlackPayloadError } from '@tulipfarm/slack-presentation';
import type { NativeTool } from './native-tools.ts';
import type { ReplyRender } from './reply-render.ts';
import { reportText } from './slack-layout-delivery.ts';
import { recoverLayoutCall } from './tool-text.ts';

export const slackRenderToolName = 'slack_render';
const checkSurfaceId = '00000000-0000-4000-8000-000000000000';
/** Blocks kept free for the feedback buttons and the canvas and TulipFarm links added at delivery. */
const reservedBlocks = 2;
const maxFollowUp = 500;
const block = z.record(z.string(), z.unknown());

export const slackRenderInputSchema = z.strictObject({
  placement: z.enum(['chat', 'canvas']),
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(2000),
  blocks: z
    .array(block)
    .min(1)
    .max(50 - reservedBlocks),
  report: z.string().trim().min(1).max(60_000).optional(),
  modals: slackLayoutSchema.shape.modals,
});
export type SlackRenderInput = z.infer<typeof slackRenderInputSchema>;

export const slackRenderTool: NativeTool = {
  name: slackRenderToolName,
  description:
    'Give your final Slack answer as Block Kit blocks. Call it alone, once all other work is done. It ends your reply.',
  parameters: z.toJSONSchema(slackRenderInputSchema, { io: 'input' }) as Record<string, unknown>,
};

const interactivePrompt = [
  '# Interactive elements',
  'Only the person who asked can use them. Each one sends their choice back to you as their next message.',
  `- A follow-up button: {"type":"button","text":{"type":"plain_text","text":"Compare prices"},"value":"Compare the prices of these plans"}. \`value\` is the message it sends, at most ${maxFollowUp} characters.`,
  '- A choice: a static_select, multi_static_select, radio_buttons, checkboxes, overflow, datepicker or timepicker in an actions block. Choosing sends the option text, so make each option text a complete answer.',
  '- A form in the message: input blocks, each with a label, then an actions block with a button whose action_id is "submit". Pressing it sends every label and answer.',
  '- A modal for a longer form: put its blocks (mostly input blocks) in `modals` with an `id`, a `title` and a `submit` label of at most 24 characters each, and open it with a button whose action_id is "open_modal:<id>".',
  '- To ask the user to choose, use these buttons or choices in your blocks. present_choice is not available in Slack.',
  '- Suggest at most three follow-ups, and only ones that would help.',
].join('\n');

/** The Slack answer rules. The text is fixed per mode, so provider prompt caches still hit. */
export const slackRenderPrompt = (interactive: boolean) =>
  [
    '# Answer format',
    `- This reply is shown in Slack. Give every final answer by calling ${slackRenderToolName}, alone, after all other work. Do not also write the answer as text.`,
    '- `summary` is one or two plain sentences that answer the question. It is the notification text. `title` names the reply in a few words.',
    '- `blocks` are Slack Block Kit blocks, at most 48. Build what reads best in Slack: a short answer is one markdown block; structure uses header, section (with fields for key facts), context, divider, table, data_table, data_visualization (bar, line, area or pie), card, carousel of cards, alert, container, rich_text, image, plan and task_card.',
    '- A markdown block holds standard Markdown. Text objects of type "mrkdwn" use Slack syntax with a single asterisk: *bold*, _italic_, `code`, <https://example.com|label>; never **bold** or [label](url) there.',
    '- Tables: when the answer compares several items across the same attributes, or lists figures by row (such as months with revenue and deals), use a table, not lists or stacked lines. Options the user names with a price and a feature, such as three CRMs, are such a comparison.',
    '- Keep numbers, prices and currency symbols as the user or the source wrote them, such as $90 or €1.5k; do not spell them out in words.',
    '- At most one table and two data_visualization blocks. A table is {"type":"table","rows":[[{"type":"raw_text","text":"Name"}, ...], ...]}; its first row is the header.',
    '- Charts: when the user asks for a chart, graph or plot, or numbers show a trend, a comparison or a share, add a data_visualization block. Never draw a chart with text, bars of characters or a code block.',
    '- A bar, line or area chart: {"type":"data_visualization","title":"Monthly revenue","chart":{"type":"line","axis_config":{"categories":["Jan","Feb","Mar"],"x_label":"Month","y_label":"Revenue ($k)"},"series":[{"name":"Revenue","data":[{"label":"Jan","value":40},{"label":"Feb","value":52},{"label":"Mar","value":47}]}]}}. Each series has one point per category, labelled with it. Use line or area for trends over time and bar for comparisons; several series compare groups, and values may be negative.',
    '- A pie chart: {"type":"data_visualization","title":"Revenue by region","chart":{"type":"pie","segments":[{"label":"North","value":60},{"label":"South","value":40}]}}. Use it for shares of a whole, with positive values.',
    '- Chart limits: title at most 50 characters; 1 to 20 categories; 1 to 12 series or segments; series names and labels at most 20 characters.',
    '- Use numbers you got from tools or the user. Never invent data for a chart, table or metric.',
    '- Sources: when you used web.search or web.fetch, end the blocks with a context block linking the pages you relied on, such as <https://example.com/pricing|Example pricing>.',
    '- `placement` is "canvas" when the user asks for a report, document or detailed view, or the answer would need more than about 40 blocks or two charts. Then also write the full report in `report` as Markdown (headings, lists and tables); it is saved as a Slack canvas. Keep `blocks` to the answer and the key facts, and the canvas is linked below them.',
    '- Do not add context_actions blocks, feedback buttons or links to TulipFarm; they are added for you.',
    '- If the tool returns errors, fix them and call it again.',
    '',
    interactive
      ? interactivePrompt
      : '- Buttons may only open links (a button with a `url`). Do not use inputs, selects or other interactive elements. present_choice is not available in Slack; to ask a question, write the options in the answer.',
  ].join('\n');

type Element = Record<string, unknown>;
const choiceElements = new Set([
  'static_select',
  'multi_static_select',
  'radio_buttons',
  'checkboxes',
  'overflow',
  'datepicker',
  'timepicker',
  'datetimepicker',
  'users_select',
  'multi_users_select',
  'conversations_select',
  'channels_select',
]);
const inputElements = new Set([
  ...choiceElements,
  'plain_text_input',
  'number_input',
  'email_text_input',
  'url_text_input',
  'rich_text_input',
  'multi_conversations_select',
  'multi_channels_select',
]);
const isObject = (value: unknown): value is Element => Boolean(value) && typeof value === 'object';

/**
 * Gives every interactive element a server action ID, so a press can only do what its kind allows: send a follow-up,
 * send a choice, submit the message's inputs, open one of the reply's modals, or open a link.
 */
function assignActions(blocks: Element[], options: { interactive: boolean; modals: Set<string>; inModal: boolean }) {
  const errors: string[] = [];
  let next = 0;
  const element = (item: Element, where: string, inInput: boolean) => {
    const type = String(item.type);
    if (type === 'button') {
      const requested = typeof item.action_id === 'string' ? item.action_id : '';
      if (typeof item.url === 'string') {
        item.action_id = `tf_link:${next++}`;
        return;
      }
      if (!options.interactive)
        return errors.push(`${where}: a button needs a url; other buttons are not allowed here.`);
      if (options.inModal) return errors.push(`${where}: a modal uses its submit label, not buttons.`);
      const modal = /^open_modal:(.+)$/u.exec(requested)?.[1];
      if (modal) {
        if (!options.modals.has(modal)) return errors.push(`${where}: no modal has the id "${modal}".`);
        item.action_id = `tf_modal:${modal}:${next++}`;
        return;
      }
      if (requested === 'submit') {
        item.action_id = `tf_submit:${next++}`;
        return;
      }
      if (typeof item.value !== 'string' || !item.value.trim() || item.value.length > maxFollowUp)
        return errors.push(
          `${where}: a follow-up button needs a \`value\` of 1 to ${maxFollowUp} characters, the message it sends.`,
        );
      item.action_id = `tf_followup:${next++}`;
      return;
    }
    if (type === 'feedback_buttons' || type === 'icon_button')
      return errors.push(`${where}: feedback buttons are added for you.`);
    if (inInput && inputElements.has(type)) {
      item.action_id = `tf_input:${next++}`;
      return;
    }
    if (choiceElements.has(type)) {
      if (!options.interactive) return errors.push(`${where}: ${type} is not allowed here.`);
      if (options.inModal) return errors.push(`${where}: put ${type} inside an input block in a modal.`);
      item.action_id = `tf_choice:${next++}`;
      return;
    }
    if (inputElements.has(type) || type === 'workflow_button')
      errors.push(
        `${where}: ${type} must be inside an input block${options.interactive ? '' : ' and is not allowed here'}.`,
      );
  };
  const visit = (items: Element[], path: string) => {
    for (const [index, item] of items.entries()) {
      const where = `${path}/${index} (${String(item.type)})`;
      switch (item.type) {
        case 'context_actions':
          errors.push(`${where}: feedback and context actions are added for you.`);
          break;
        case 'actions':
          if (Array.isArray(item.elements))
            for (const [at, child] of item.elements.entries())
              if (isObject(child)) element(child, `${where}/elements/${at}`, false);
          break;
        case 'section':
          if (isObject(item.accessory)) element(item.accessory, `${where}/accessory`, false);
          break;
        case 'input':
          if (!options.interactive) errors.push(`${where}: input blocks are not allowed here.`);
          else if (isObject(item.element)) element(item.element, `${where}/element`, true);
          delete item.dispatch_action;
          break;
        case 'card':
          if (Array.isArray(item.actions))
            for (const [at, child] of item.actions.entries())
              if (isObject(child)) element(child, `${where}/actions/${at}`, false);
          break;
        case 'carousel':
          if (Array.isArray(item.elements)) visit(item.elements.filter(isObject), `${where}/elements`);
          break;
        case 'container':
          if (Array.isArray(item.child_blocks)) visit(item.child_blocks.filter(isObject), `${where}/child_blocks`);
          break;
      }
    }
  };
  visit(blocks, options.inModal ? '/modals' : '/blocks');
  return errors;
}

/** Markdown bold and links that models write in mrkdwn text, which Slack would show as literal characters. */
export function markdownToMrkdwn(text: string) {
  return text
    .replace(/\*\*([^*\n]+)\*\*/gu, '*$1*')
    .replace(/\[([^\]\n]+)\]\(((?:https?|mailto):[^)\s]+)\)/gu, '<$2|$1>');
}

/** Rewrites every mrkdwn text object in place, inside blocks, fields and elements. */
function fixMrkdwn(value: unknown) {
  if (Array.isArray(value)) return value.forEach(fixMrkdwn);
  if (!isObject(value)) return;
  if (value.type === 'mrkdwn' && typeof value.text === 'string') value.text = markdownToMrkdwn(value.text);
  Object.values(value).forEach(fixMrkdwn);
}

/** Slack mrkdwn as Markdown: bold, strike and links. */
export function mrkdwnToMarkdown(text: string) {
  return text
    .replace(/<((?:https?|mailto):[^|>\s]+)\|([^>]+)>/gu, '[$2]($1)')
    .replace(/<((?:https?|mailto):[^|>\s]+)>/gu, '$1')
    .replace(/<[@#!][^>]*>/gu, '')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/gu, '$1**$2**')
    .replace(/(^|[\s(])~([^~\n]+)~(?=[\s).,!?:;]|$)/gu, '$1~~$2~~');
}

const textOf = (value: unknown): string => {
  if (!isObject(value)) return typeof value === 'string' ? value : '';
  if (typeof value.text === 'string') return value.type === 'mrkdwn' ? mrkdwnToMarkdown(value.text) : value.text;
  if (value.type === 'link' && typeof value.url === 'string') return value.url;
  if (value.type === 'user' || value.type === 'channel' || value.type === 'usergroup') return '';
  if (value.type === 'emoji' && typeof value.name === 'string') return `:${value.name}:`;
  if (Array.isArray(value.elements)) {
    const separator = value.type === 'rich_text_list' ? '\n' : value.type === 'rich_text' ? '\n\n' : '';
    return value.elements
      .map(item => (value.type === 'rich_text_list' ? `- ${textOf(item)}` : textOf(item)))
      .join(separator);
  }
  return '';
};

/** The Slack blocks as A2UI, so the web chat shows the same reply: interactive Slack elements become notes. */
function slackBlocksToA2ui(input: SlackRenderInput) {
  const components: Element[] = [];
  let next = 0;
  const add = (component: Element) => {
    const id = `c${next++}`;
    components.push({ id, ...component });
    return id;
  };
  const text = (value: string, caption = false) =>
    value.trim() ? add({ component: 'Text', text: value, ...(caption ? { variant: 'caption' } : {}) }) : undefined;
  const cellText = (cell: unknown) =>
    isObject(cell) && typeof cell.text === 'string' ? cell.text : isObject(cell) ? textOf(cell) : '';
  const convert = (item: Element): string | undefined => {
    switch (item.type) {
      case 'header':
        return add({ component: 'Heading', text: textOf(item.text) || ' ', level: 2 });
      case 'markdown':
        return text(String(item.text ?? ''));
      case 'section': {
        const parts = [textOf(item.text), ...(Array.isArray(item.fields) ? item.fields.map(textOf) : [])];
        const body = text(parts.filter(Boolean).join('\n\n'));
        const accessory = isObject(item.accessory) ? element(item.accessory) : undefined;
        return accessory && body ? add({ component: 'Row', children: [body, accessory] }) : (body ?? accessory);
      }
      case 'rich_text':
        return text(textOf(item));
      case 'context':
        return text(Array.isArray(item.elements) ? item.elements.map(textOf).filter(Boolean).join(' · ') : '', true);
      case 'divider':
        return add({ component: 'Divider' });
      case 'image':
        return text(`[${String(item.alt_text ?? 'Image')}](${String(item.image_url ?? '')})`);
      case 'video':
        return text(`[${textOf(item.title) || 'Video'}](${String(item.title_url ?? item.video_url ?? '')})`);
      case 'alert': {
        const tones: Record<string, string> = {
          info: 'info',
          warning: 'warning',
          error: 'error',
          success: 'success',
        };
        return add({
          component: 'Callout',
          tone: tones[String(item.level)] ?? 'neutral',
          text: textOf(item.text) || ' ',
        });
      }
      case 'actions': {
        const children = (Array.isArray(item.elements) ? item.elements.filter(isObject) : [])
          .map(element)
          .filter((id): id is string => Boolean(id));
        return children.length ? add({ component: 'Row', children }) : undefined;
      }
      case 'input':
        return text(`Form field: ${textOf(item.label)}`, true);
      case 'table':
      case 'data_table': {
        const rows = Array.isArray(item.rows) ? item.rows.filter(Array.isArray) : [];
        const [head = [], ...body] = rows;
        const columns = head.map((cell, index) => ({
          key: `k${index}`,
          label: cellText(cell) || `Column ${index + 1}`,
        }));
        if (!columns.length) return undefined;
        return add({
          component: 'Table',
          label: typeof item.caption === 'string' ? item.caption : 'Table',
          columns,
          rows: body.map(row => Object.fromEntries(row.map((cell, index) => [`k${index}`, cellText(cell)]))),
        });
      }
      case 'data_visualization': {
        const chart = isObject(item.chart) ? item.chart : {};
        if (chart.type === 'pie' && Array.isArray(chart.segments))
          return add({
            component: 'Chart',
            type: 'pie',
            title: String(item.title ?? 'Chart'),
            category: 'label',
            series: [{ key: 'value', label: 'Value' }],
            rows: chart.segments.filter(isObject).map(segment => ({ label: segment.label, value: segment.value })),
          });
        const series = Array.isArray(chart.series) ? chart.series.filter(isObject) : [];
        const categories =
          isObject(chart.axis_config) && Array.isArray(chart.axis_config.categories)
            ? chart.axis_config.categories
            : [];
        return add({
          component: 'Chart',
          type: ['bar', 'line', 'area'].includes(String(chart.type)) ? chart.type : 'bar',
          title: String(item.title ?? 'Chart'),
          category: 'category',
          series: series.map((entry, index) => ({ key: `s${index}`, label: String(entry.name) })),
          rows: categories.map(category => ({
            category,
            ...Object.fromEntries(
              series.map((entry, index) => [
                `s${index}`,
                (Array.isArray(entry.data) ? entry.data.filter(isObject) : []).find(point => point.label === category)
                  ?.value ?? 0,
              ]),
            ),
          })),
        });
      }
      case 'card': {
        const children = [
          textOf(item.body) ? text(textOf(item.body)) : undefined,
          textOf(item.subtext) ? text(textOf(item.subtext), true) : undefined,
          ...(Array.isArray(item.actions) ? item.actions.filter(isObject).map(element) : []),
        ].filter((id): id is string => Boolean(id));
        return add({
          component: 'Card',
          ...(textOf(item.title) ? { title: textOf(item.title) } : {}),
          ...(textOf(item.subtitle) ? { description: textOf(item.subtitle) } : {}),
          children,
        });
      }
      case 'carousel': {
        const children = (Array.isArray(item.elements) ? item.elements.filter(isObject) : [])
          .map(card => convert({ ...card, type: 'card' }))
          .filter((id): id is string => Boolean(id));
        return children.length ? add({ component: 'Row', children }) : undefined;
      }
      case 'container': {
        const children = (Array.isArray(item.child_blocks) ? item.child_blocks.filter(isObject) : [])
          .map(convert)
          .filter((id): id is string => Boolean(id));
        return add({ component: 'Section', ...(textOf(item.title) ? { title: textOf(item.title) } : {}), children });
      }
      case 'plan':
      case 'task_card': {
        const tasks = item.type === 'plan' && Array.isArray(item.tasks) ? item.tasks.filter(isObject) : [item];
        const marks: Record<string, string> = { complete: '✓', error: '✗', in_progress: '…', pending: '○' };
        const lines = tasks.map(task => `${marks[String(task.status)] ?? '○'} ${String(task.title ?? '')}`);
        return text(`${item.type === 'plan' ? `**${String(item.title ?? 'Plan')}**\n\n` : ''}${lines.join('\n\n')}`);
      }
      default:
        return undefined;
    }
  };
  function element(item: Element): string | undefined {
    const action = String(item.action_id ?? '');
    if (item.type === 'button') {
      const label = textOf(item.text) || 'Open';
      if (typeof item.url === 'string') return text(`[${label}](${item.url})`);
      if (action.startsWith('tf_followup:') && typeof item.value === 'string')
        return add({ component: 'Button', label, action: followUpAction(item.value) });
      return text(`${label} (in Slack)`, true);
    }
    if (Array.isArray(item.options))
      return text(
        `Options in Slack: ${item.options
          .filter(isObject)
          .map(option => textOf(option.text))
          .join(', ')}`,
        true,
      );
    return undefined;
  }
  const children = input.blocks.map(convert).filter((id): id is string => Boolean(id));
  if (!children.length) children.push(add({ component: 'Text', text: input.summary }));
  components.push({ id: 'root', component: 'Column', children });
  return [
    {
      version: layoutVersion,
      createSurface: { surfaceId: checkSurfaceId, catalogId: layoutSurfaceCatalogId, components },
    },
  ] as ReplyRenderInput['messages'];
}

const reason = (error: unknown) => (error instanceof SlackPayloadError ? error.reason : String(error));
const failed = (errors: string[]): ReplyRender => ({
  ok: false,
  error: `Invalid Slack blocks. Fix these and call ${slackRenderToolName} again:\n${errors
    .slice(0, 20)
    .map(error => `- ${error}`)
    .join('\n')}`,
});

/** A run of block characters, the usual sign of a bar chart drawn in text. */
const textChart = /[\u2580-\u259f\u25a0-\u25aa\u25ac]{3,}/u;
/** A line that starts with a bold name and carries a price: one option of a comparison written as a list. */
const pricedOption = /^\s*(?:[-•*]\s+)?\*{1,2}[^*\n]{1,80}\*{1,2}[^\n]*?[$€£₹]\s?\d/u;

const textsOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(textsOf)
    : isObject(value)
      ? Object.entries(value).flatMap(([key, item]) =>
          key === 'text' && typeof item === 'string' ? [item] : textsOf(item),
        )
      : [];

/** Layout advice sent back once: valid blocks that leave out web sources or list a priced comparison as lines. */
function designHints(blocks: Element[], usedWeb: boolean) {
  const hints: string[] = [];
  const json = JSON.stringify(blocks);
  if (usedWeb && !/https?:\/\//u.test(json))
    hints.push(
      'You used web pages: end the blocks with a context block linking the main sources, such as <https://example.com/pricing|Example pricing>.',
    );
  const hasTable = blocks.some(item => item.type === 'table' || item.type === 'data_table');
  const options = textsOf(blocks)
    .flatMap(text => text.split('\n'))
    .filter(line => pricedOption.test(line));
  if (!hasTable && options.length >= 3)
    hints.push('These options are compared on price: show them in a table block, one row per option.');
  return hints;
}

/**
 * Checks a `slack_render` call against Slack's Block Kit rules. On success the input is a web layout built from the
 * blocks, with the Slack blocks, report and modals kept for delivery. With `design`, valid blocks may also come back
 * once with layout advice.
 */
export function parseSlackRender(
  input: unknown,
  options: { interactive: boolean; design?: boolean; usedWeb?: boolean },
): ReplyRender {
  const parsed = slackRenderInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: `Invalid Slack reply: ${z.prettifyError(parsed.error)}` };
  const value: SlackRenderInput = structuredClone(parsed.data);
  fixMrkdwn(value.blocks);
  fixMrkdwn(value.modals);
  if (value.placement === 'canvas' && !value.report)
    return failed(['A canvas placement needs the full report in `report`.']);
  const modalIds = new Set(value.modals?.map(modal => modal.id));
  if (modalIds.size !== (value.modals?.length ?? 0)) return failed(['Each modal needs a different id.']);
  if (value.modals?.length && !options.interactive) return failed(['Modals are not allowed here.']);
  const errors = assignActions(value.blocks, { ...options, modals: modalIds, inModal: false });
  for (const modal of value.modals ?? [])
    errors.push(...assignActions(modal.blocks, { ...options, modals: modalIds, inModal: true }));
  if (textChart.test(JSON.stringify(value.blocks)))
    errors.push('Draw charts with a data_visualization block, not with characters in text or code.');
  if (errors.length) return failed(errors);
  try {
    parseSlackSurface({ kind: 'message', text: value.summary, blocks: value.blocks });
  } catch (error) {
    return failed([`blocks: ${reason(error)}`]);
  }
  for (const modal of value.modals ?? [])
    try {
      parseSlackSurface({ kind: 'modal', view: slackModalView(modal, '') as never });
    } catch (error) {
      return failed([`modal ${modal.id}: ${reason(error)}`]);
    }
  const layout: ReplyRenderInput = {
    placement: value.placement,
    title: value.title,
    summary: value.summary,
    messages: slackBlocksToA2ui(value),
    slack: {
      blocks: value.blocks,
      ...(value.report ? { report: value.report } : {}),
      ...(value.modals?.length ? { modals: value.modals } : {}),
    },
  };
  const checked = layoutFromReply(layout, checkSurfaceId);
  if (!checked.ok)
    return failed(checked.errors.map(error => `The web copy of these blocks failed: ${error.path}: ${error.message}`));
  if (options.design) {
    const hints = designHints(value.blocks, options.usedWeb ?? false);
    if (hints.length)
      return {
        ok: false,
        error: `Improve these and call ${slackRenderToolName} again:\n${hints.map(hint => `- ${hint}`).join('\n')}`,
      };
  }
  return { ok: true, input: layout, text: layoutText(checked.layout) };
}

/** One or two plain sentences from Markdown, for a reply's notification text. */
function plainSummary(text: string) {
  const plain = mrkdwnToMarkdown(text)
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/gu, '$1')
    .replace(/[*_`#>~|]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const sentence = /^.{20,280}?[.!?](?=\s|$)/u.exec(plain)?.[0] ?? plain;
  return sentence.length > 300 ? `${sentence.slice(0, 297).trimEnd()}...` : sentence;
}

/**
 * A `slack_render` call that a model wrote as text, read back as the tool's input. The title and summary default
 * from the blocks when the text leaves them out. `undefined` when the text holds no Block Kit array.
 */
export function slackRenderFromText(text: string): SlackRenderInput | undefined {
  const call = recoverLayoutCall(text, {
    list: 'blocks',
    fields: ['placement', 'title', 'summary', 'report', 'modals'],
  });
  if (!call) return undefined;
  const blocks = call.blocks as SlackRenderInput['blocks'];
  const string = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const report = string(call.report);
  return {
    placement: call.placement === 'canvas' && report ? 'canvas' : 'chat',
    title: (string(call.title) ?? 'Answer').slice(0, 120),
    summary: (string(call.summary) ?? (plainSummary(textsOf(blocks).join(' ')) || 'Answer')).slice(0, 2000),
    blocks,
    ...(report ? { report } : {}),
    ...(Array.isArray(call.modals) ? { modals: call.modals as SlackRenderInput['modals'] } : {}),
  };
}

/**
 * A plain-text answer as `slack_render` input: one markdown block, so the reply is posted like any laid-out answer,
 * with the TulipFarm link and feedback buttons. An answer longer than a message holds is kept whole as a canvas
 * report, and the message shows it cut at a paragraph.
 */
export function slackRenderFromAnswer(text: string): SlackRenderInput {
  const answer = text.trim();
  const cut = reportText(answer);
  return {
    placement: cut === answer ? 'chat' : 'canvas',
    title: 'Answer',
    summary: plainSummary(answer) || 'Answer',
    blocks: [{ type: 'markdown', text: cut }],
    ...(cut === answer ? {} : { report: answer.slice(0, 60_000) }),
  };
}
