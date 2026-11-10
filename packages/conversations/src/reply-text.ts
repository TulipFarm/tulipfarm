import { log } from '@tulipfarm/observability';

const marker = 'TULIPMEM';
const trailingMarker = /(?:^|\r?\n)TULIPMEM\s*$/u;

export function withoutTrailingControlMarker(text: string, streaming = false, model = 'unknown'): string {
  // Defensive strip for a model-emitted marker with no known producer.
  const cleaned = text.replace(trailingMarker, '');
  if (cleaned !== text) {
    log('info', 'inference', 'call_completed', {
      operation: 'chat.reply-marker',
      'gen_ai.request.model': model,
      marker_stripped: true,
    });
    return cleaned;
  }
  if (!streaming) return text;
  const newline = text.lastIndexOf('\n');
  const tail = text.slice(newline + 1);
  if (!tail || !marker.startsWith(tail)) return text;
  return newline < 0 ? '' : text.slice(0, text[newline - 1] === '\r' ? newline - 1 : newline);
}
