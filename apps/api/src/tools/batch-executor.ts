/** Schedules synchronous read Tools in parallel and mutating Tools sequentially. */
export class BatchCoordinator {
  private queue: Array<{
    fn: () => Promise<unknown>;
    mutating: boolean;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }> = [];
  private flushScheduled = false;

  schedule<T>(fn: () => Promise<T>, mutating: boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, mutating, resolve: resolve as (v: unknown) => void, reject });
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        queueMicrotask(() => this.flush());
      }
    });
  }

  private async flush(): Promise<void> {
    const batch = this.queue.splice(0);
    this.flushScheduled = false;
    const anyMutating = batch.some((b) => b.mutating);
    if (!anyMutating) {
      await Promise.all(batch.map(({ fn, resolve, reject }) => fn().then(resolve, reject)));
    } else {
      for (const { fn, resolve, reject } of batch) {
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        }
      }
    }
  }
}
