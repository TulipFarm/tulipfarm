import {
  PRODUCT_TELEMETRY_ENDPOINT,
  PRODUCT_TELEMETRY_INTERVAL_MS,
  PRODUCT_TELEMETRY_MAX_BYTES,
  type ProductTelemetryBootstrapData,
  type ProductTelemetryEvent,
  type ProductTelemetryLevel,
  type ProductTelemetrySnapshotData,
  parseProductTelemetryEvent,
} from "./product-telemetry";

export interface ProductTelemetryState {
  installationId: string;
  firstBootAt: string;
  level: ProductTelemetryLevel;
  configured: boolean;
  setupComplete: boolean;
  bootstrapSentAt: string | null;
  lastSnapshotAt: string | null;
  pending: ProductTelemetryEvent | null;
  bootstrapReport?: ProductTelemetryEvent;
  attempts: number;
  retryAt: string | null;
}

export interface ProductTelemetryStateStore {
  initialize(initial: ProductTelemetryState): Promise<void>;
  /** Serializes mutation and delivery against preference changes across all replicas. */
  locked<T>(fn: (state: ProductTelemetryState) => Promise<T>): Promise<T>;
}

export interface ProductTelemetryReporterOptions {
  store: ProductTelemetryStateStore;
  production: boolean;
  maxLevel: ProductTelemetryLevel;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  setupComplete?(): Promise<boolean>;
  bootstrap(): Promise<Omit<ProductTelemetryBootstrapData, "first_boot_at">>;
  snapshot(): Promise<ProductTelemetrySnapshotData>;
}

export function productTelemetryPolicy(env: Record<string, string | undefined>) {
  const raw = env.TULIPFARM_TELEMETRY_LEVEL?.trim() || undefined;
  const maxLevel: ProductTelemetryLevel =
    raw === undefined || raw === "2" ? 2 : raw === "1" ? 1 : 0;
  return { maxLevel, enabled: env.NODE_ENV === "production" };
}

export class ProductTelemetryReporter {
  private readonly now: () => Date;
  constructor(private readonly options: ProductTelemetryReporterOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    await this.options.store.initialize({
      installationId: crypto.randomUUID(),
      firstBootAt: this.now().toISOString(),
      level: 2,
      configured: false,
      setupComplete: false,
      bootstrapSentAt: null,
      lastSnapshotAt: null,
      pending: null,
      attempts: 0,
      retryAt: null,
    });
    if (await this.options.setupComplete?.()) await this.completeSetup();
  }

  async completeSetup(level?: ProductTelemetryLevel): Promise<void> {
    await this.options.store.locked(async (state) => {
      if (level === undefined && !state.setupComplete) {
        state.configured = false;
        this.purge(state);
      }
      state.setupComplete = true;
      if (level !== undefined) this.setLevel(state, level);
    });
  }

  async configure(level: ProductTelemetryLevel): Promise<void> {
    await this.options.store.locked(async (state) => this.setLevel(state, level));
  }

  async save(level: ProductTelemetryLevel) {
    await this.configure(level);
    return this.status();
  }

  private effective(level: ProductTelemetryLevel): ProductTelemetryLevel {
    return Math.min(level, this.options.maxLevel) as ProductTelemetryLevel;
  }

  private setLevel(state: ProductTelemetryState, level: ProductTelemetryLevel): void {
    state.level = level;
    state.configured = true;
    this.purge(state);
  }

  private purge(state: ProductTelemetryState): void {
    if (
      state.pending?.event_type === "instance_snapshot" &&
      (!state.configured || state.pending.telemetry_level > this.effective(state.level))
    ) {
      state.pending = null;
      state.attempts = 0;
      state.retryAt = null;
    }
  }

  private async event(
    state: ProductTelemetryState,
    type: "instance_bootstrapped" | "instance_snapshot",
    level: ProductTelemetryLevel
  ): Promise<ProductTelemetryEvent> {
    let data: ProductTelemetryBootstrapData | ProductTelemetrySnapshotData;
    if (type === "instance_bootstrapped") {
      data = { ...(await this.options.bootstrap()), first_boot_at: state.firstBootAt };
    } else {
      const inventory = await this.options.snapshot();
      const {
        resource_type_names,
        integration_providers,
        skill_names,
        agent_names,
        inventory_truncated,
        ...counts
      } = inventory;
      data = level === 1 ? counts : inventory;
      if (level === 2) {
        const lists = [
          inventory.resource_type_names,
          inventory.integration_providers,
          inventory.skill_names,
          inventory.agent_names,
        ].filter((value): value is string[] => value !== undefined);
        for (const list of lists) {
          if (list.length > 200) {
            list.length = 200;
            inventory.inventory_truncated = true;
          }
        }
        while (
          JSON.stringify(inventory).length * 2 + 2048 > PRODUCT_TELEMETRY_MAX_BYTES ||
          new TextEncoder().encode(JSON.stringify(inventory)).length + 2048 >
            PRODUCT_TELEMETRY_MAX_BYTES
        ) {
          const longest = [...lists].sort((a, b) => b.length - a.length)[0];
          if (!longest?.length) break;
          longest.pop();
          inventory.inventory_truncated = true;
        }
      }
    }
    return parseProductTelemetryEvent({
      schema_version: 1,
      event_id: type === "instance_bootstrapped" ? state.installationId : crypto.randomUUID(),
      installation_id: state.installationId,
      event_type: type,
      occurred_at: type === "instance_bootstrapped" ? state.firstBootAt : this.now().toISOString(),
      telemetry_level: level,
      data,
    });
  }

  async status(candidate?: ProductTelemetryLevel) {
    const state = await this.options.store.locked(async (current) => {
      this.purge(current);
      return structuredClone(current);
    });
    const effectiveLevel = this.effective(candidate ?? state.level);
    const bootstrap =
      state.bootstrapReport ??
      (state.setupComplete && !state.bootstrapSentAt
        ? state.pending?.event_type === "instance_bootstrapped"
          ? state.pending
          : await this.event(state, "instance_bootstrapped", 0)
        : null);
    const snapshot =
      effectiveLevel > 0
        ? state.pending?.event_type === "instance_snapshot" &&
          state.pending.telemetry_level === effectiveLevel
          ? state.pending
          : await this.event(state, "instance_snapshot", effectiveLevel)
        : null;
    return {
      level: state.level,
      effectiveLevel,
      maxLevel: this.options.maxLevel,
      enabled: this.options.production,
      configured: state.configured,
      installationId: state.installationId,
      bootstrapSentAt: state.bootstrapSentAt,
      lastSnapshotAt: state.lastSnapshotAt,
      preview: { bootstrap, snapshot },
    };
  }

  private due(state: ProductTelemetryState): "instance_bootstrapped" | "instance_snapshot" | null {
    if (!state.setupComplete || state.pending) return null;
    if (!state.bootstrapSentAt) return "instance_bootstrapped";
    if (
      state.configured &&
      this.effective(state.level) > 0 &&
      (!state.lastSnapshotAt ||
        this.now().getTime() - Date.parse(state.lastSnapshotAt) >= PRODUCT_TELEMETRY_INTERVAL_MS)
    )
      return "instance_snapshot";
    return null;
  }

  async dispatch(): Promise<{ sent: boolean }> {
    if (!this.options.production) return { sent: false };
    const endpoint = this.options.endpoint?.trim() || PRODUCT_TELEMETRY_ENDPOINT;
    try {
      const url = new URL(endpoint);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
        return { sent: false };
    } catch {
      return { sent: false };
    }
    const current = await this.options.store.locked(async (state) => {
      this.purge(state);
      return structuredClone(state);
    });
    const due = this.due(current);
    /** Inventory reads need the pool, so they must precede the state transaction. */
    const candidate = due
      ? await this.event(
          current,
          due,
          due === "instance_bootstrapped" ? 0 : this.effective(current.level)
        )
      : null;
    if (candidate)
      await this.options.store.locked(async (state) => {
        this.purge(state);
        if (
          this.due(state) === candidate.event_type &&
          candidate.telemetry_level <= this.effective(state.level)
        )
          state.pending = candidate;
      });
    /** The committed payload and held row lock fence retries, replicas and downgrades. */
    return this.options.store.locked(async (state) => {
      this.purge(state);
      if (!state.pending || (state.retryAt && Date.parse(state.retryAt) > this.now().getTime()))
        return { sent: false };
      const event = parseProductTelemetryEvent(state.pending);
      try {
        const response = await (this.options.fetchImpl ?? fetch)(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error("Telemetry delivery declined");
        if (event.event_type === "instance_bootstrapped") {
          state.bootstrapSentAt = this.now().toISOString();
          state.bootstrapReport = event;
        } else state.lastSnapshotAt = this.now().toISOString();
        state.pending = null;
        state.attempts = 0;
        state.retryAt = null;
        return { sent: true };
      } catch {
        state.attempts += 1;
        state.retryAt = new Date(
          this.now().getTime() + Math.min(86400000, 60000 * 2 ** Math.min(state.attempts - 1, 11))
        ).toISOString();
        return { sent: false };
      }
    });
  }
}
