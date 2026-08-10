import { describe, expect, it } from "vitest";
import {
  deriveSample,
  PgResourceSamplePruner,
  PgResourceWriter,
  processResourceProbe,
  type ResourceQueryable,
  type ResourceReading,
  type ResourceSampleRecord,
  ResourceSampler,
  type ResourceWriter,
} from "./resources";

const IDENTITY = { id: "sample-1", service: "api" as const, instance: "host:1" };

function reading(nowMs: number, cpuMicros: number, rssBytes = 100): ResourceReading {
  return { nowMs, cpuMicros, rssBytes };
}

/** A probe that advances a private clock 60s per reading and reports no CPU consumption. */
function steppingProbe(): () => ResourceReading {
  let now = 0;
  return () => {
    now += 60_000;
    return reading(now, 0);
  };
}

/**
 * Lets the writer's promise chain settle, as a real 60s gap between ticks always would. Drains
 * microtasks rather than using a timer, because this package compiles with no platform lib.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

class CapturingWriter implements ResourceWriter {
  readonly written: ResourceSampleRecord[] = [];
  async write(record: ResourceSampleRecord): Promise<void> {
    this.written.push(record);
  }
}

/** A scheduler whose tick is fired by the test rather than by the clock. */
function manualSchedule() {
  let fire: (() => void) | null = null;
  let cleared = false;
  return {
    schedule: (callback: () => void) => {
      fire = callback;
      return () => {
        cleared = true;
        fire = null;
      };
    },
    tick: () => fire?.(),
    get cleared() {
      return cleared;
    },
  };
}

describe("deriveSample", () => {
  it("derives percent of one core from the cumulative delta", () => {
    // 30s of CPU consumed over 60s of wall clock = half a core.
    const sample = deriveSample(reading(0, 0), reading(60_000, 30_000_000), IDENTITY);
    expect(sample?.cpuPct).toBeCloseTo(50, 6);
  });

  it("allows readings above 100 percent rather than clamping to one core", () => {
    // Two cores fully saturated for the interval — clamping would hide the most important case.
    const sample = deriveSample(reading(0, 0), reading(60_000, 120_000_000), IDENTITY);
    expect(sample?.cpuPct).toBeCloseTo(200, 6);
  });

  it("carries identity, the current rss, and the current instant", () => {
    const sample = deriveSample(reading(0, 0), reading(60_000, 0, 4096), IDENTITY);
    expect(sample).toMatchObject({
      id: "sample-1",
      service: "api",
      instance: "host:1",
      rssBytes: 4096,
    });
    expect(sample?.ts.getTime()).toBe(60_000);
  });

  it("returns null when no wall time elapsed", () => {
    expect(deriveSample(reading(1000, 0), reading(1000, 5), IDENTITY)).toBeNull();
  });

  it("returns null when the clock stepped backwards", () => {
    expect(deriveSample(reading(5000, 0), reading(1000, 5), IDENTITY)).toBeNull();
  });

  it("returns null when the cpu counter went backwards", () => {
    expect(deriveSample(reading(0, 900), reading(60_000, 100), IDENTITY)).toBeNull();
  });

  it("returns null for a non-finite or negative rss", () => {
    expect(deriveSample(reading(0, 0), reading(60_000, 0, Number.NaN), IDENTITY)).toBeNull();
    expect(deriveSample(reading(0, 0), reading(60_000, 0, -1), IDENTITY)).toBeNull();
  });
});

describe("ResourceSampler", () => {
  it("writes nothing on the first tick — it only establishes the baseline", () => {
    const writer = new CapturingWriter();
    const clock = manualSchedule();
    const sampler = new ResourceSampler({
      service: "api",
      instance: "host:1",
      // start() consumes the first reading; the first tick is the second.
      probe: steppingProbe(),
      writer,
      newId: () => "id",
      schedule: clock.schedule,
    });

    sampler.start();
    expect(writer.written).toHaveLength(0);
    clock.tick();
    expect(writer.written).toHaveLength(1);
  });

  it("differences successive readings rather than reporting lifetime totals", async () => {
    const writer = new CapturingWriter();
    const clock = manualSchedule();
    // A process that has already burned 10 minutes of CPU before sampling starts, then idles.
    const readings = [
      reading(0, 600_000_000),
      reading(60_000, 600_600_000),
      reading(120_000, 601_200_000),
    ];
    let i = 0;
    const sampler = new ResourceSampler({
      service: "worker",
      instance: "host:2",
      probe: () => {
        const next = readings[i];
        i += 1;
        return next;
      },
      writer,
      newId: () => `id-${i}`,
      schedule: clock.schedule,
    });

    sampler.start();
    clock.tick();
    await settle();
    clock.tick();
    await settle();
    // 0.6s of CPU per 60s interval = 1%, not the enormous lifetime average.
    expect(writer.written.map((r) => r.cpuPct)).toEqual([1, 1]);
  });

  it("survives a probe that throws and resumes on the next tick", () => {
    const writer = new CapturingWriter();
    const clock = manualSchedule();
    const errors: unknown[] = [];
    let i = 0;
    const readings: (ResourceReading | Error)[] = [
      reading(0, 0),
      new Error("probe blew up"),
      reading(120_000, 60_000_000),
    ];
    const sampler = new ResourceSampler({
      service: "api",
      instance: "host:1",
      probe: () => {
        const next = readings[i];
        i += 1;
        if (next instanceof Error) throw next;
        return next;
      },
      writer,
      newId: () => "id",
      schedule: clock.schedule,
      onWriteError: (e) => errors.push(e),
    });

    sampler.start();
    expect(() => clock.tick()).not.toThrow();
    expect(writer.written).toHaveLength(0);
    expect(errors).toHaveLength(1);

    // The failed probe must not have corrupted the baseline: 60s of CPU over the 120s since start.
    clock.tick();
    expect(writer.written).toHaveLength(1);
    expect(writer.written[0].cpuPct).toBeCloseTo(50, 6);
  });

  it("reports a failed write without throwing into the caller", async () => {
    const errors: unknown[] = [];
    const clock = manualSchedule();
    const sampler = new ResourceSampler({
      service: "api",
      instance: "host:1",
      probe: steppingProbe(),
      writer: {
        write: () => Promise.reject(new Error("database is down")),
      },
      newId: () => "id",
      schedule: clock.schedule,
      onWriteError: (e) => errors.push(e),
    });

    sampler.start();
    expect(() => clock.tick()).not.toThrow();
    await sampler.stop();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("database is down");
  });

  it("drops a tick rather than queueing behind a stalled write", async () => {
    const clock = manualSchedule();
    const releases: (() => void)[] = [];
    let writes = 0;
    const sampler = new ResourceSampler({
      service: "api",
      instance: "host:1",
      probe: steppingProbe(),
      writer: {
        write: () => {
          writes += 1;
          return new Promise<void>((resolve) => {
            releases.push(resolve);
          });
        },
      },
      newId: () => "id",
      schedule: clock.schedule,
    });

    sampler.start();
    clock.tick();
    clock.tick();
    clock.tick();
    expect(writes).toBe(1);

    for (const release of releases) release();
    await sampler.stop();
    // Once the stall clears, sampling resumes.
    sampler.start();
    clock.tick();
    expect(writes).toBe(2);
  });

  it("stop() clears the timer and awaits the in-flight write", async () => {
    const clock = manualSchedule();
    let settled = false;
    const sampler = new ResourceSampler({
      service: "api",
      instance: "host:1",
      probe: steppingProbe(),
      writer: {
        write: async () => {
          await Promise.resolve();
          settled = true;
        },
      },
      newId: () => "id",
      schedule: clock.schedule,
    });

    sampler.start();
    clock.tick();
    await sampler.stop();
    expect(settled).toBe(true);
    expect(clock.cleared).toBe(true);
  });

  it("stop() is safe when never started", async () => {
    const sampler = new ResourceSampler({
      service: "api",
      instance: "host:1",
      probe: () => reading(0, 0),
      writer: new CapturingWriter(),
    });
    await expect(sampler.stop()).resolves.toBeUndefined();
  });

  it("start() is idempotent", () => {
    const clock = manualSchedule();
    let probes = 0;
    const sampler = new ResourceSampler({
      service: "api",
      instance: "host:1",
      probe: () => {
        probes += 1;
        return reading(probes * 60_000, 0);
      },
      writer: new CapturingWriter(),
      schedule: clock.schedule,
    });
    sampler.start();
    sampler.start();
    expect(probes).toBe(1);
  });
});

describe("processResourceProbe", () => {
  it("sums user and system time and reads rss from a process-shaped runtime", () => {
    const probe = processResourceProbe(
      {
        cpuUsage: () => ({ user: 1_500, system: 500 }),
        memoryUsage: () => ({ rss: 8192 }),
      },
      () => 4242
    );
    expect(probe()).toEqual({ cpuMicros: 2_000, rssBytes: 8192, nowMs: 4242 });
  });
});

describe("PgResourceWriter", () => {
  it("inserts one row with a rounded byte count", async () => {
    const calls: { sql: string; params?: unknown[] }[] = [];
    const database: ResourceQueryable = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    };
    await new PgResourceWriter(database).write({
      id: "id-1",
      ts: new Date(1000),
      service: "integration-worker",
      instance: "host:3",
      cpuPct: 12.5,
      rssBytes: 4096.7,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("INSERT INTO resource_sample");
    expect(calls[0].params).toEqual([
      "id-1",
      new Date(1000),
      "integration-worker",
      "host:3",
      12.5,
      4097,
    ]);
  });
});

describe("PgResourceSamplePruner", () => {
  it("counts deletions through RETURNING because rowCount is not in the contract", async () => {
    const database: ResourceQueryable = {
      query: async () => ({ rows: [{ id: "a" }, { id: "b" }] }),
    };
    await expect(new PgResourceSamplePruner(database).deleteOlderThan(new Date(0))).resolves.toBe(
      2
    );
  });
});
