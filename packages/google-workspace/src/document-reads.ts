import { GoogleOperationError, type GoogleOperation } from './operation-contracts.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
type TextRange = { startIndex: number; endIndex: number };

function object(value: Json | undefined): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GoogleOperationError('invalid-response');
  return value;
}

function array(value: Json | undefined): Json[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new GoogleOperationError('invalid-response');
  return value;
}

function bounded(value: ObjectValue): Json {
  if (JSON.stringify(value).length > 64_000) throw new GoogleOperationError('response-too-large');
  return value;
}

function identity(value: ObjectValue, key: string): ObjectValue {
  if (typeof value[key] !== 'string' || typeof value.revisionId !== 'string')
    throw new GoogleOperationError('invalid-response');
  return { [key]: value[key], revisionId: value.revisionId };
}

function tabs(values: Json[]): ObjectValue[] {
  return values.flatMap(value => {
    const tab = object(value);
    return [tab, ...tabs(array(tab.childTabs))];
  });
}

// Google indexes and JavaScript string offsets both count UTF-16 code units.
function clip(value: Json, range: TextRange): Json | undefined {
  if (Array.isArray(value))
    return value.flatMap(item => {
      const selected = clip(item, range);
      return selected === undefined ? [] : [selected];
    });
  if (!value || typeof value !== 'object') return value;
  const start = typeof value.startIndex === 'number' ? value.startIndex : 0;
  const end = typeof value.endIndex === 'number' ? value.endIndex : undefined;
  if (end !== undefined && (end <= range.startIndex || start >= range.endIndex)) return undefined;
  if (value.textRun !== undefined) {
    const run = object(value.textRun);
    if (typeof run.content !== 'string' || end === undefined) throw new GoogleOperationError('invalid-response');
    const from = Math.max(start, range.startIndex),
      to = Math.min(end, range.endIndex);
    return {
      ...value,
      startIndex: from,
      endIndex: to,
      textRun: { ...run, content: run.content.slice(from - start, to - start) },
    };
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const selected = clip(item, range);
      return selected === undefined ? [] : [[key, selected]];
    }),
  );
}

function segmentEnd(content: Json | undefined): number {
  return array(content).reduce<number>((end, item) => {
    const entry = object(item);
    if (typeof entry.endIndex !== 'number') throw new GoogleOperationError('invalid-response');
    return Math.max(end, entry.endIndex);
  }, 0);
}

export function selectDocument(
  result: Json,
  selection: NonNullable<Extract<GoogleOperation, { kind: 'docs.documents.get' }>['selection']>,
): Json {
  const document = object(result),
    meta = identity(document, 'documentId');
  if (typeof document.title === 'string') meta.title = document.title;
  const allTabs = tabs(array(document.tabs));
  if (selection.view === 'outline') {
    return bounded({
      ...meta,
      tabs: allTabs.map(tab => {
        const contents = object(tab.documentTab);
        const segments: Json[] = [{ kind: 'body', endIndex: segmentEnd(object(contents.body).content) }];
        for (const kind of ['headers', 'footers', 'footnotes']) {
          if (contents[kind] === undefined) continue;
          for (const [segmentId, segment] of Object.entries(object(contents[kind]))) {
            segments.push({ kind, segmentId, endIndex: segmentEnd(object(segment).content) });
          }
        }
        return { tabProperties: object(tab.tabProperties), segments };
      }),
    });
  }
  const tab = allTabs.find(value => object(value.tabProperties).tabId === selection.tabId);
  if (!tab) throw new GoogleOperationError('provider-rejected');
  const contents = object(tab.documentTab);
  let segment = contents.body;
  if (selection.segmentId) {
    segment = undefined;
    for (const kind of ['headers', 'footers', 'footnotes']) {
      if (contents[kind] === undefined) continue;
      const entries = object(contents[kind]);
      if (Object.hasOwn(entries, selection.segmentId)) segment = entries[selection.segmentId];
    }
    if (segment === undefined) throw new GoogleOperationError('provider-rejected');
  }
  const content = array(object(segment).content);
  return bounded({
    ...meta,
    tabId: selection.tabId,
    ...(selection.segmentId ? { segmentId: selection.segmentId } : {}),
    range: selection.range,
    segmentEndIndex: segmentEnd(content),
    content: clip(content, selection.range) ?? [],
  });
}

function findElement(
  elements: Json[],
  id: string,
  ancestors: ObjectValue[] = [],
): { element: ObjectValue; ancestors: ObjectValue[] } | undefined {
  for (const item of elements) {
    const element = object(item);
    if (typeof element.objectId !== 'string') throw new GoogleOperationError('invalid-response');
    if (element.objectId === id) return { element, ancestors };
    if (element.elementGroup !== undefined) {
      const parent: ObjectValue = { objectId: element.objectId };
      if (element.transform !== undefined) parent.transform = element.transform;
      const found = findElement(array(object(element.elementGroup).children), id, [...ancestors, parent]);
      if (found) return found;
    }
  }
  return undefined;
}

export function selectSlidePage(
  result: Json,
  detail: NonNullable<Extract<GoogleOperation, { kind: 'slides.presentations.pages.get' }>['detail']>,
): Json {
  const page = object(result),
    meta = identity(page, 'objectId');
  if (!detail.elementId) return bounded(page);
  const found = findElement(array(page.pageElements), detail.elementId);
  if (!found) throw new GoogleOperationError('provider-rejected');
  let element = found.element;
  if (detail.cellLocation) {
    const table = object(element.table);
    const cells = array(table.tableRows)
      .flatMap(row => array(object(row).tableCells))
      .map(object);
    const cell = cells.find(value => {
      const location = object(value.location);
      return (
        (location.rowIndex ?? 0) === detail.cellLocation?.rowIndex &&
        (location.columnIndex ?? 0) === detail.cellLocation?.columnIndex
      );
    });
    if (!cell) throw new GoogleOperationError('provider-rejected');
    element = { objectId: detail.elementId, cellLocation: detail.cellLocation, cell };
  }
  return bounded({
    ...meta,
    ancestors: found.ancestors,
    element: detail.range ? object(clip(element, detail.range)) : element,
    ...(detail.range ? { range: detail.range } : {}),
  });
}
