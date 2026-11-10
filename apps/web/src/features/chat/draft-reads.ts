import { errorStatus, retryDelay, retryRead, workspaceUpdating } from '@/lib/query/policy';

type WaitingRead = { start: () => void };
const waiting: WaitingRead[] = [];
let active = 0;

export function scheduleDraftRead<T>(signal: AbortSignal, load: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      const index = waiting.indexOf(entry);
      if (index !== -1) waiting.splice(index, 1);
      reject(signal.reason);
    };
    const entry: WaitingRead = {
      start() {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) {
          reject(signal.reason);
          waiting.shift()?.start();
          return;
        }
        active++;
        void load()
          .then(resolve, reject)
          .finally(() => {
            active--;
            waiting.shift()?.start();
          });
      },
    };
    if (signal.aborted) return reject(signal.reason);
    if (active < 3) entry.start();
    else {
      waiting.push(entry);
      signal.addEventListener('abort', abort, { once: true });
    }
  });
}

export function retryDraftRead(failures: number, error: unknown) {
  if (workspaceUpdating(error) || errorStatus(error) === 429) return retryRead(failures, error);
  return failures < 3 && (errorStatus(error) === 0 || retryRead(0, error));
}

export function draftRetryDelay(attempt: number, error: unknown) {
  const delay = retryDelay(attempt, error);
  return workspaceUpdating(error) || errorStatus(error) === 429
    ? delay
    : Math.min(30_000, delay * (1 + Math.random() * 0.25));
}
