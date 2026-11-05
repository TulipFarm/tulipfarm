function toolEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(toolEnvelope);
  const object = value as Record<string, unknown>;
  if (typeof object.tool === 'string' && /^[a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/.test(object.tool)) return true;
  if (object.kind === 'tool' && object.call && typeof object.call === 'object') return true;
  if (object.kind === 'parallel' && Array.isArray(object.calls)) return true;
  if (object.type === 'tool_use' || object.type === 'function_call') return true;
  if (typeof object.decision === 'string') {
    try {
      return toolEnvelope(JSON.parse(object.decision));
    } catch {
      return false;
    }
  }
  return object.decision !== undefined && toolEnvelope(object.decision);
}

/** A tool call written out in a provider's XML markup: an `<invoke>` or `<function_calls>` tag with `<parameter name=...>`. */
const markupCall = /<\/?(?:function[ _]?calls?|(?:\w+:)?invoke)\b[^>]*>/i;
const markupParameter = /<(?:\w+:)?parameter\s+name\s*=/i;

export function containsToolEnvelope(text: string): boolean {
  if (markupCall.test(text) && markupParameter.test(text)) return true;
  const candidates = [
    text.trim(),
    ...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(match => match[1]!.trim()),
  ];
  const start = text.indexOf('{'),
    end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  return candidates.some(candidate => {
    try {
      return toolEnvelope(JSON.parse(candidate));
    } catch {
      return /"kind"\s*:\s*"(?:tool|parallel)"/.test(candidate) && /"(?:call|calls)"\s*:/.test(candidate);
    }
  });
}

// Keep structured output off the preview until its complete response can be classified.
export function toolTextPreview(text: string): string | undefined {
  const start = text.search(/[{[`]/);
  return start < 0 ? text : text.slice(0, start) || undefined;
}

/** A Block Kit array, as a layout call written out as text carries it: `[{"type":"section", ...`. */
const blockArray =
  /\[\s*\{\s*"type"\s*:\s*"(?:header|section|actions|divider|context|rich_text|table|markdown|input|data_visualization|image)"/;

/** True when an answer describes a call to the layout tool `name` instead of making it. */
export function writesLayoutCall(text: string, name: string): boolean {
  return text.includes(name) || blockArray.test(text);
}

/** The JSON value whose opening bracket is at `start`, or `undefined` when the bracketed text does not parse. */
function jsonAt(text: string, start: number): unknown {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      if (--depth > 0) continue;
      try {
        return JSON.parse(text.slice(start, index + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Reads back the input of a layout call that a model wrote as text instead of making it: a JSON object holding
 * `list`, or prose such as `title is Hello summary is A greeting. blocks is [...]`. Only `list` and `fields` are
 * returned; the caller validates them as it would a real call. `undefined` when `list` is not a JSON array.
 */
export function recoverLayoutCall(
  text: string,
  shape: { list: string; fields: readonly string[] },
): Record<string, unknown> | undefined {
  const keys = [shape.list, ...shape.fields];
  const pick = (object: Record<string, unknown>) =>
    Array.isArray(object[shape.list])
      ? Object.fromEntries(keys.filter(key => object[key] !== undefined).map(key => [key, object[key]]))
      : undefined;
  // A JSON object, alone or wrapped as a call's `input`, `arguments` or `parameters`.
  for (
    let start = text.indexOf('{'), tries = 0;
    start >= 0 && tries < 20;
    start = text.indexOf('{', start + 1), tries++
  ) {
    const value = jsonAt(text, start);
    if (!isRecord(value)) continue;
    for (const candidate of [value, value.input, value.arguments, value.parameters]) {
      const object = typeof candidate === 'string' ? jsonAt(candidate, candidate.indexOf('{')) : candidate;
      const picked = isRecord(object) ? pick(object) : undefined;
      if (picked) return picked;
    }
  }
  // Prose: each `key is value` (or `key: value`, `key = value`) runs until the next key.
  const markers = keys
    .map(key => {
      const match = new RegExp(`(?:^|[^\\w])"?${escapeRegExp(key)}"?\\s*(?:\\bis\\b|=|:)\\s*`, 'i').exec(text);
      return match ? { key, start: match.index, end: match.index + match[0].length } : undefined;
    })
    .filter(marker => marker !== undefined)
    .sort((a, b) => a.start - b.start);
  const listMarker = markers.find(marker => marker.key === shape.list);
  const list = listMarker && text[listMarker.end] === '[' ? jsonAt(text, listMarker.end) : undefined;
  if (!Array.isArray(list)) return undefined;
  const result: Record<string, unknown> = { [shape.list]: list };
  markers.forEach((marker, index) => {
    if (marker.key === shape.list) return;
    const value = text
      .slice(marker.end, markers[index + 1]?.start ?? text.length)
      .trim()
      .replace(/[.,;]+$/u, '')
      .replace(/^(["'`])([\s\S]*)\1$/u, '$2')
      .trim();
    if (value) result[marker.key] = value;
  });
  return result;
}
