import { browserViewport, type BrowserInput } from '@tulipfarm/browser/contracts';

type Size = { width: number; height: number };

/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function inputModifiers(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

/** Maps a point on the shown screen, at any size, to the browser's viewport. */
export function viewportPoint(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
  size: Size = browserViewport,
) {
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
  return {
    x: clamp(Math.round(((clientX - rect.left) * size.width) / Math.max(rect.width, 1)), size.width),
    y: clamp(Math.round(((clientY - rect.top) * size.height) / Math.max(rect.height, 1)), size.height),
  };
}

/** The text a key types, if any. Shortcuts and named keys such as Enter type nothing. */
export function typedText(event: { key: string; metaKey: boolean; ctrlKey: boolean }) {
  return event.key.length === 1 && !event.metaKey && !event.ctrlKey ? event.key : undefined;
}

// Requests to the browser host stay well under its 64 KB body limit.
const maxBatchBytes = 16 * 1024;
const maxBatchInputs = 50;

/** How many of the waiting inputs fit in the next request: at least one, and in order. */
export function inputBatch(inputs: readonly BrowserInput[]) {
  let bytes = 0;
  let count = 0;
  for (const input of inputs.slice(0, maxBatchInputs)) {
    bytes += JSON.stringify(input).length;
    if (count && bytes > maxBatchBytes) break;
    count++;
  }
  return count;
}
