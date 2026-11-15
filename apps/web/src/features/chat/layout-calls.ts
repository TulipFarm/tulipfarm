import { useSyncExternalStore } from 'react';
import type { RendererCall } from '@tulipfarm/conversations/events';

/** Renderer calls that arrive later than this are stale, such as after the person left the chat. */
const lifetimeMs = 60_000;
const none: readonly RendererCall[] = [];

let calls = new Map<string, { calls: readonly RendererCall[]; at: number }>();
const settled = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

/** Holds the renderer calls of a just-saved reply until its surface runs them. They are never stored, so a reload skips them. */
export function queueRendererCalls(messageId: string, next: readonly RendererCall[]) {
  const known = new Set(calls.get(messageId)?.calls.map(call => call.callRendererFunction.functionCallId));
  const added = next.filter(
    call =>
      !known.has(call.callRendererFunction.functionCallId) && !settled.has(call.callRendererFunction.functionCallId),
  );
  if (!added.length) return;
  calls = new Map(calls).set(messageId, { calls: [...(calls.get(messageId)?.calls ?? []), ...added], at: Date.now() });
  notify();
}

/** Drops a call once it ran, so a surface drawn again, such as in Canvas, does not repeat it. */
export function settleRendererCall(messageId: string, functionCallId: string) {
  settled.add(functionCallId);
  const entry = calls.get(messageId);
  if (!entry) return;
  const rest = entry.calls.filter(call => call.callRendererFunction.functionCallId !== functionCallId);
  if (rest.length === entry.calls.length) return;
  calls = new Map(calls);
  if (rest.length) calls.set(messageId, { ...entry, calls: rest });
  else calls.delete(messageId);
  notify();
}

export function useRendererCalls(messageId: string): readonly RendererCall[] {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => {
      const entry = calls.get(messageId);
      return entry && Date.now() - entry.at < lifetimeMs ? entry.calls : none;
    },
  );
}
