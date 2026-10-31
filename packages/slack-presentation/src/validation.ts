import { validateSurface } from './block-schema.js';
import { blockSurfaces, type SlackSurface } from './surfaces.ts';

function isSurface(value: unknown): value is SlackSurface {
  return validateSurface(value);
}
/** The message stays fixed for callers that match it; `reason` says which rule failed, for the model to fix. */
export class SlackPayloadError extends Error {
  constructor(readonly reason = 'The payload does not match Slack Block Kit.') {
    super('slack-payload-invalid');
  }
}

/** Finds the first block that fails the Block Kit schema, so the error names it. */
function schemaReason(value: unknown) {
  const surface = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const view = surface.view && typeof surface.view === 'object' ? (surface.view as Record<string, unknown>) : {};
  const blocks = surface.kind === 'message' ? surface.blocks : view.blocks;
  if (!Array.isArray(blocks)) return 'The surface has no blocks array.';
  for (const [index, block] of blocks.entries()) {
    if (!validateSurface({ kind: 'message', text: 'check', blocks: [block] })) {
      const error = validateSurface.errors?.[0];
      const type = block && typeof block === 'object' ? String((block as { type?: unknown }).type) : typeof block;
      return `Block ${index} (${type}) does not match Slack Block Kit${error ? ` at ${error.instancePath.replace(/^\/blocks\/0/, '') || '/'}: ${error.message}` : ''}.`;
    }
  }
  return 'The surface fields do not match Slack Block Kit.';
}

const limitReason = (type: string) => `A ${type} block breaks a Slack limit on its size, count or fields.`;

export function parseSlackSurface(value: unknown): SlackSurface {
  if (!isSurface(value)) throw new SlackPayloadError(schemaReason(value));
  if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024)
    throw new SlackPayloadError('The payload is larger than 128 KB.');
  const blocks = value.kind === 'message' ? value.blocks : value.view.blocks;
  const maxBlocks = value.kind === 'message' ? 50 : 100;
  if (!blocks.length || blocks.length > maxBlocks)
    throw new SlackPayloadError(`A ${value.kind} has 1 to ${maxBlocks} blocks, not ${blocks.length}.`);
  if (value.kind === 'message' && (!value.text.trim() || value.text.length > 40000))
    throw new SlackPayloadError('The fallback text must have 1 to 40,000 characters.');
  if (value.kind === 'modal') {
    for (const text of [value.view.title, value.view.submit, value.view.close]) {
      if (text && (!text.text.trim() || text.text.length > 24))
        throw new SlackPayloadError('A modal title, submit and close text have 1 to 24 characters.');
    }
    if (blocks.some(block => block.type === 'input') && !value.view.submit)
      throw new SlackPayloadError('A modal with input blocks needs a submit label.');
  }
  let markdown = 0;
  let tables = 0;
  let charts = 0;
  let tableCharacters = 0;
  let dataTableCharacters = 0;
  function textSize(value: unknown): number {
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + textSize(item), 0);
    if (value && typeof value === 'object') {
      return Object.entries(value).reduce(
        (sum, [key, item]) => sum + (key === 'text' && typeof item === 'string' ? item.length : textSize(item)),
        0,
      );
    }
    return 0;
  }
  const ids = new Set<string>();
  const visit = (nodes: typeof blocks) => {
    for (const block of nodes) {
      const supported: readonly string[] = blockSurfaces[block.type];
      if (!supported.includes(value.kind))
        throw new SlackPayloadError(`A ${block.type} block cannot be used in a ${value.kind}.`);
      if (block.block_id) {
        if (block.block_id.length > 255 || ids.has(block.block_id))
          throw new SlackPayloadError(`block_id ${block.block_id} is repeated or longer than 255 characters.`);
        ids.add(block.block_id);
      }
      switch (block.type) {
        case 'markdown':
          markdown += block.text.length;
          break;
        case 'section':
          if (
            (!block.text && !block.fields?.length) ||
            (block.text?.text.length ?? 0) > 3000 ||
            (block.fields?.length ?? 0) > 10 ||
            block.fields?.some(field => field.text.length > 2000)
          )
            throw new SlackPayloadError(limitReason(block.type));
          break;
        case 'header':
          if (!block.text.text.trim() || block.text.text.length > 150)
            throw new SlackPayloadError(limitReason(block.type));
          break;
        case 'actions':
          if (!block.elements.length || block.elements.length > 25)
            throw new SlackPayloadError(limitReason(block.type));
          break;
        case 'context':
          if (!block.elements.length || block.elements.length > 10)
            throw new SlackPayloadError(limitReason(block.type));
          break;
        case 'context_actions':
          if (!block.elements.length || block.elements.length > 5) throw new SlackPayloadError(limitReason(block.type));
          break;
        case 'input':
          if (block.element.type === 'file_input' && (value.kind !== 'modal' || block.dispatch_action))
            throw new SlackPayloadError(limitReason(block.type));
          break;
        case 'card':
          if (!block.hero_image && !block.title && !block.body && !block.actions?.length)
            throw new SlackPayloadError(limitReason(block.type));
          if ((block.actions?.length ?? 0) > 3 || (block.icon && block.slack_icon))
            throw new SlackPayloadError(limitReason(block.type));
          if (
            [block.title, block.subtitle].some(text => text && text.text.length > 150) ||
            [block.body, block.subtext].some(text => text && text.text.length > 200)
          )
            throw new SlackPayloadError(limitReason(block.type));
          break;
        case 'carousel':
          if (!block.elements.length || block.elements.length > 10)
            throw new SlackPayloadError(limitReason(block.type));
          visit(block.elements);
          break;
        case 'container':
          if (
            !block.child_blocks.length ||
            block.child_blocks.length > 10 ||
            (block.title?.text.length ?? 0) > 150 ||
            (block.subtitle?.text.length ?? 0) > 150
          )
            throw new SlackPayloadError(limitReason(block.type));
          visit(block.child_blocks);
          if (block.rich_text_title) visit([block.rich_text_title]);
          break;
        case 'plan':
          if (
            !block.tasks.length ||
            block.tasks.length > 50 ||
            new Set(block.tasks.map(task => task.task_id)).size !== block.tasks.length
          )
            throw new SlackPayloadError(limitReason(block.type));
          visit(block.tasks.map(task => ({ ...task, type: 'task_card' })));
          break;
        case 'task_card':
          if (block.details) visit([block.details]);
          if (block.output) visit([block.output]);
          break;
        case 'table':
        case 'data_table': {
          if (block.type === 'table') tables++;
          if (block.type === 'table') tableCharacters += textSize(block.rows);
          else dataTableCharacters += textSize(block.rows);
          const width = block.rows[0]?.length ?? 0;
          if (
            width < 1 ||
            width > 20 ||
            block.rows.length < (block.type === 'table' ? 1 : 2) ||
            block.rows.length > (block.type === 'table' ? 100 : 201) ||
            block.rows.some(row => row.length !== width)
          )
            throw new SlackPayloadError(limitReason(block.type));
          if (
            block.type === 'data_table' &&
            (block.rows[0]?.some(cell => cell.type === 'rich_text') ||
              (block.page_size !== undefined &&
                (!Number.isInteger(block.page_size) || block.page_size < 1 || block.page_size > 100)))
          )
            throw new SlackPayloadError(limitReason(block.type));
          for (const row of block.rows) for (const cell of row) if (cell.type === 'rich_text') visit([cell]);
          break;
        }
        case 'data_visualization': {
          charts++;
          if (block.title.length > 50)
            throw new SlackPayloadError('A data_visualization title has at most 50 characters.');
          const chart = block.chart;
          if (chart.type === 'pie') {
            if (
              !chart.segments.length ||
              chart.segments.length > 12 ||
              chart.segments.some(segment => segment.value <= 0 || segment.label.length > 20)
            )
              throw new SlackPayloadError(
                'A pie chart has 1 to 12 segments, each with a positive value and a label of at most 20 characters.',
              );
          } else {
            const categories = chart.axis_config.categories;
            if (
              !categories.length ||
              categories.length > 20 ||
              new Set(categories).size !== categories.length ||
              !chart.series.length ||
              chart.series.length > 12 ||
              new Set(chart.series.map(series => series.name)).size !== chart.series.length
            )
              throw new SlackPayloadError(
                'A bar, line or area chart has 1 to 20 distinct axis_config.categories and 1 to 12 series with distinct names.',
              );
            if (
              chart.series.some(
                series =>
                  series.name.length > 20 ||
                  series.data.length !== categories.length ||
                  new Set(series.data.map(point => point.label)).size !== categories.length ||
                  series.data.some(point => !categories.includes(point.label)),
              )
            )
              throw new SlackPayloadError(
                'Each chart series has a name of at most 20 characters and exactly one data point per category, labelled with that category.',
              );
          }
          break;
        }
      }
    }
  };
  visit(blocks);
  if (markdown > 12000 || tables > 1 || charts > 2 || tableCharacters > 10000 || dataTableCharacters > 20000)
    throw new SlackPayloadError(
      'A message has at most 12,000 markdown characters, one table, two charts, 10,000 table characters and 20,000 data_table characters.',
    );
  return value;
}
