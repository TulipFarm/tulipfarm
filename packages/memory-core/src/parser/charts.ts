import { stripPlaceholderMarkers } from './media-contracts.js';
import { escapeMarkdown } from './tokens.js';
import type { XmlElement } from './xml.js';

const chartNs = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const drawingNs = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const diagramNs = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';

export function* walk(node: XmlElement): Generator<XmlElement> {
  yield node;
  for (const child of node.children) yield* walk(child);
}

function local(node: XmlElement, namespace: string, name: string): boolean {
  return node.name === `${namespace}|${name}`;
}

function child(node: XmlElement | undefined, namespace: string, name: string): XmlElement | undefined {
  return node?.children.find(value => local(value, namespace, name));
}

function clean(value: string): string {
  return stripPlaceholderMarkers(value)
    .replace(/[^\P{Cc}\t]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text of DrawingML paragraphs (`a:p`) under a node, one entry per non-empty paragraph. */
export function drawingParagraphs(node: XmlElement): string[] {
  const result: string[] = [];
  for (const paragraph of walk(node)) {
    if (!local(paragraph, drawingNs, 'p')) continue;
    const text = clean(
      [...walk(paragraph)]
        .filter(value => local(value, drawingNs, 't'))
        .map(value => value.text)
        .join(''),
    );
    if (text) result.push(text);
  }
  return result;
}

function cell(value: string): string {
  return escapeMarkdown(clean(value)).replace(/\|/g, '\\|');
}

function points(node: XmlElement | undefined): Map<number, string> {
  const values = new Map<number, string>();
  if (!node) return values;
  for (const point of walk(node)) {
    if (!local(point, chartNs, 'pt')) continue;
    const index = Number(point.attributes.get('|idx'));
    const value = child(point, chartNs, 'v')?.text ?? '';
    // Multi-level categories keep the first level seen for an index.
    if (Number.isSafeInteger(index) && index >= 0 && index < 100_000 && !values.has(index)) values.set(index, value);
  }
  return values;
}

/** A chart's cached data as a bold title and a Markdown table, matching AnyDoc's rendering of native charts. */
export function chartMarkdown(chart: XmlElement): string {
  const body = child(chart, chartNs, 'chart');
  const title = clean(drawingParagraphs(child(body, chartNs, 'title') ?? { ...chart, children: [] }).join(' '));
  const series = [...walk(child(body, chartNs, 'plotArea') ?? { ...chart, children: [] })].filter(node =>
    local(node, chartNs, 'ser'),
  );
  const columns = series.map((value, index) => {
    const name = [...walk(child(value, chartNs, 'tx') ?? { ...value, children: [] })]
      .filter(node => local(node, chartNs, 'v') || local(node, drawingNs, 't'))
      .map(node => node.text)
      .join('');
    return {
      name: clean(name) || `Series ${index + 1}`,
      categories: points(child(value, chartNs, 'cat') ?? child(value, chartNs, 'xVal')),
      values: points(child(value, chartNs, 'val') ?? child(value, chartNs, 'yVal')),
    };
  });
  const indexes = [...new Set(columns.flatMap(column => [...column.categories.keys(), ...column.values.keys()]))].sort(
    (a, b) => a - b,
  );
  const parts: string[] = [];
  if (title) parts.push(`**${escapeMarkdown(title)}**`);
  if (columns.length && indexes.length) {
    const rows = indexes.slice(0, 10_000).map(index => {
      const category = columns.find(column => column.categories.has(index))?.categories.get(index) ?? '';
      return `| ${[cell(category), ...columns.map(column => cell(column.values.get(index) ?? ''))].join(' | ')} |`;
    });
    parts.push(
      [
        `|  | ${columns.map(column => cell(column.name)).join(' | ')} |`,
        `| ${['---', ...columns.map(() => '---')].join(' | ')} |`,
        ...rows,
      ].join('\n'),
    );
  }
  return parts.join('\n\n');
}

/** SmartArt text from its data model, as a bulleted list in document order. */
export function diagramMarkdown(data: XmlElement): string {
  const items: string[] = [];
  for (const point of walk(data)) {
    if (!local(point, diagramNs, 'pt')) continue;
    const type = point.attributes.get('|type') ?? 'node';
    if (type !== 'node') continue;
    const text = drawingParagraphs(child(point, diagramNs, 't') ?? { ...point, children: [] }).join(' ');
    if (text) items.push(`- ${escapeMarkdown(text)}`);
  }
  return items.join('\n');
}

/** Plain paragraphs of text, escaped for Markdown. */
export function paragraphsMarkdown(paragraphs: string[]): string {
  return paragraphs.map(escapeMarkdown).join('\n\n');
}
