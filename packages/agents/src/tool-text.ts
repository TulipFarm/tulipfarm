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
