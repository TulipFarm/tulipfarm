import { validateSurface } from './block-schema.js';
import { blockSurfaces, type SlackSurface } from './surfaces.ts';

function isSurface(value: unknown): value is SlackSurface {
  return validateSurface(value);
}
export class SlackPayloadError extends Error {
  constructor() {
    super('slack-payload-invalid');
  }
}

export function parseSlackSurface(value: unknown): SlackSurface {
  if (!isSurface(value) || Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) throw new SlackPayloadError();
  const blocks = value.kind === 'message' ? value.blocks : value.view.blocks;
  if (!blocks.length || blocks.length > (value.kind === 'message' ? 50 : 100)) throw new SlackPayloadError();
  if (value.kind === 'message' && (!value.text.trim() || value.text.length > 40000)) throw new SlackPayloadError();
  if (value.kind === 'modal') {
    for (const text of [value.view.title, value.view.submit, value.view.close]) {
      if (text && (!text.text.trim() || text.text.length > 24)) throw new SlackPayloadError();
    }
    if (blocks.some(block => block.type === 'input') && !value.view.submit) throw new SlackPayloadError();
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
      if (!supported.includes(value.kind)) throw new SlackPayloadError();
      if (block.block_id) {
        if (block.block_id.length > 255 || ids.has(block.block_id)) throw new SlackPayloadError();
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
            throw new SlackPayloadError();
          break;
        case 'header':
          if (!block.text.text.trim() || block.text.text.length > 150) throw new SlackPayloadError();
          break;
        case 'actions':
          if (!block.elements.length || block.elements.length > 25) throw new SlackPayloadError();
          break;
        case 'context':
          if (!block.elements.length || block.elements.length > 10) throw new SlackPayloadError();
          break;
        case 'context_actions':
          if (!block.elements.length || block.elements.length > 5) throw new SlackPayloadError();
          break;
        case 'input':
          if (block.element.type === 'file_input' && (value.kind !== 'modal' || block.dispatch_action))
            throw new SlackPayloadError();
          break;
        case 'card':
          if (!block.hero_image && !block.title && !block.body && !block.actions?.length) throw new SlackPayloadError();
          if ((block.actions?.length ?? 0) > 3 || (block.icon && block.slack_icon)) throw new SlackPayloadError();
          if (
            [block.title, block.subtitle].some(text => text && text.text.length > 150) ||
            [block.body, block.subtext].some(text => text && text.text.length > 200)
          )
            throw new SlackPayloadError();
          break;
        case 'carousel':
          if (!block.elements.length || block.elements.length > 10) throw new SlackPayloadError();
          visit(block.elements);
          break;
        case 'container':
          if (
            !block.child_blocks.length ||
            block.child_blocks.length > 10 ||
            (block.title?.text.length ?? 0) > 150 ||
            (block.subtitle?.text.length ?? 0) > 150
          )
            throw new SlackPayloadError();
          visit(block.child_blocks);
          if (block.rich_text_title) visit([block.rich_text_title]);
          break;
        case 'plan':
          if (
            !block.tasks.length ||
            block.tasks.length > 50 ||
            new Set(block.tasks.map(task => task.task_id)).size !== block.tasks.length
          )
            throw new SlackPayloadError();
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
            throw new SlackPayloadError();
          if (
            block.type === 'data_table' &&
            (block.rows[0]?.some(cell => cell.type === 'rich_text') ||
              (block.page_size !== undefined &&
                (!Number.isInteger(block.page_size) || block.page_size < 1 || block.page_size > 100)))
          )
            throw new SlackPayloadError();
          for (const row of block.rows) for (const cell of row) if (cell.type === 'rich_text') visit([cell]);
          break;
        }
        case 'data_visualization': {
          charts++;
          if (block.title.length > 50) throw new SlackPayloadError();
          const chart = block.chart;
          if (chart.type === 'pie') {
            if (
              !chart.segments.length ||
              chart.segments.length > 12 ||
              chart.segments.some(segment => segment.value <= 0 || segment.label.length > 20)
            )
              throw new SlackPayloadError();
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
              throw new SlackPayloadError();
            if (
              chart.series.some(
                series =>
                  series.name.length > 20 ||
                  series.data.length !== categories.length ||
                  new Set(series.data.map(point => point.label)).size !== categories.length ||
                  series.data.some(point => !categories.includes(point.label)),
              )
            )
              throw new SlackPayloadError();
          }
          break;
        }
      }
    }
  };
  visit(blocks);
  if (markdown > 12000 || tables > 1 || charts > 2 || tableCharacters > 10000 || dataTableCharacters > 20000)
    throw new SlackPayloadError();
  return value;
}
