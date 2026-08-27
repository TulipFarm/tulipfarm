import { EventEmitter } from "node:events";
import { RUN_EVENT_NOTIFY_CHANNEL } from "@tulipfarm/storage";
import { Client } from "pg";

const RECONNECT_DELAY_MS = 1000;

export interface NotifyWait {
  readonly promise: Promise<void>;
  /** Detaches the listener; safe to call whether or not `promise` already settled. */
  cancel(): void;
}

/**
 * Dedicated LISTEN connection for `run_events` NOTIFYs (trigger: `packages/storage/src/runs/events.ts`).
 * A caller's poll loop stays the source of truth — this only shortcuts its sleep, so a missed
 * notification (a reconnect gap, a dropped Client) costs at most one poll interval, never a stuck
 * stream.
 */
export class RunEventNotifyListener {
  private readonly emitter = new EventEmitter();
  private client: Client | undefined;
  private closed = false;

  constructor(private readonly connectionOptions: { connectionString: string; options?: string }) {
    this.emitter.setMaxListeners(0);
  }

  async start(log: (msg: string) => void = () => {}): Promise<void> {
    if (this.closed) return;
    const client = new Client(this.connectionOptions);
    this.client = client;
    client.on("notification", (msg) => {
      const runId = msg.payload?.split(":")[0];
      if (runId) this.emitter.emit(runId);
    });
    client.on("error", (err) => {
      log(`run event listener error: ${err instanceof Error ? err.message : String(err)}`);
      this.reconnect(log);
    });
    client.on("end", () => this.reconnect(log));
    await client.connect();
    await client.query(`LISTEN ${RUN_EVENT_NOTIFY_CHANNEL}`);
  }

  private reconnect(log: (msg: string) => void): void {
    if (this.closed || this.client === undefined) return;
    this.client = undefined;
    setTimeout(() => {
      this.start(log).catch((err) =>
        log(`run event listener reconnect failed: ${err instanceof Error ? err.message : err}`)
      );
    }, RECONNECT_DELAY_MS).unref();
  }

  /** Resolves on the next notification for `runId`; never rejects, so a stuck LISTEN never hangs a poll. */
  waitForNotify(runId: string): NotifyWait {
    let handler: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      handler = resolve;
      this.emitter.once(runId, handler);
    });
    return { promise, cancel: () => this.emitter.removeListener(runId, handler) };
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.client?.end().catch(() => {});
  }
}
