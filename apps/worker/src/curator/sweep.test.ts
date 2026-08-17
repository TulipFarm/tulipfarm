import { beforeEach, expect, test, vi } from "vitest";
import { sweepCurator } from "./sweep";

const backlog = vi.fn();
const log = { info: vi.fn(), error: vi.fn() };

const RECONCILE = "/api/v1/internal/curator/reconcile";

function makeApi(mint: unknown = { outcome: "minted" }, repair: unknown = {}) {
  const require = vi.fn(async (_method: string, path: string, _body?: unknown) =>
    path === RECONCILE ? repair : mint
  );
  return { require: require as never };
}

function allCalls(api: { require: unknown }) {
  return (api.require as { mock: { calls: [string, string, unknown?][] } }).mock.calls;
}

/** The bodies of the mint posts only, so a test asserts fan-out without restating the repair. */
function mintBodies(api: { require: unknown }) {
  return allCalls(api)
    .filter(([, path]) => path !== RECONCILE)
    .map(([, , body]) => body);
}

beforeEach(() => {
  vi.clearAllMocks();
  backlog.mockResolvedValue([]);
});

test("mints one job per user with a backlog, then one for the business", async () => {
  backlog.mockResolvedValue(["user-a", "user-b"]);
  const api = makeApi();

  const result = await sweepCurator({ businessId: "biz", backlog, api });

  expect(mintBodies(api)).toEqual([
    { scope: "user", userId: "user-a" },
    { scope: "user", userId: "user-b" },
    { scope: "business" },
  ]);
  expect(result.minted).toBe(3);
});

// The business half is what keeps knowledge promotion alive when nobody has chatted.
test("still mints for the business when no user has a backlog", async () => {
  const api = makeApi();
  await sweepCurator({ businessId: "biz", backlog, api });

  expect(mintBodies(api)).toEqual([{ scope: "business" }]);
});

test("counts a refusal as skipped rather than a failure", async () => {
  const api = makeApi({ outcome: "skipped", reason: "live_job" });
  const result = await sweepCurator({ businessId: "biz", backlog, api });

  expect(result).toEqual({ recovered: 0, abandoned: 0, minted: 0, skipped: 1, failed: 0 });
});

// One bad target must not strand the rest of the backlog behind it.
test("continues past a failing mint and still reaches the business", async () => {
  backlog.mockResolvedValue(["user-a", "user-b"]);
  const require = vi.fn(async (_method: string, path: string, body?: unknown) => {
    if (path === RECONCILE) return {};
    if ((body as { userId?: string }).userId === "user-a") throw new Error("budget exhausted");
    return { outcome: "minted" };
  });
  const api = { require: require as never };

  const result = await sweepCurator({ businessId: "biz", backlog, api, log });

  expect(result).toEqual({ recovered: 0, abandoned: 0, minted: 2, skipped: 0, failed: 1 });
  expect(mintBodies(api)).toHaveLength(3);
  expect(log.error).toHaveBeenCalledWith(expect.stringContaining("budget exhausted"));
});

test("bounds one sweep so a large business drains steadily", async () => {
  const api = makeApi();
  await sweepCurator({ businessId: "biz", backlog, api, userLimit: 3 });

  expect(backlog).toHaveBeenCalledWith({ businessId: "biz", limit: 3 });
});

// Silence on an idle instance: a log line every five minutes forever buries the ones that matter.
test("says nothing when the sweep found nothing to do", async () => {
  const api = makeApi({ outcome: "skipped" });
  await sweepCurator({ businessId: "biz", backlog, api, log });

  expect(log.info).not.toHaveBeenCalled();
});

// A job that crashed between claiming work and starting its Run holds the target's unique index.
// Repairing after the backlog read would leave that user refused for another whole tick.
test("repairs stalled jobs before reading the backlog, so a freed target mints this tick", async () => {
  const order: string[] = [];
  const require = vi.fn(async (_method: string, path: string) => {
    order.push(path === RECONCILE ? "reconcile" : "mint");
    return path === RECONCILE ? { recovered: 2, abandoned: 1 } : { outcome: "minted" };
  });
  backlog.mockImplementation(async () => {
    order.push("backlog");
    return ["user-a"];
  });

  const result = await sweepCurator({
    businessId: "biz",
    backlog,
    api: { require: require as never },
  });

  expect(order).toEqual(["reconcile", "backlog", "mint", "mint"]);
  expect(result.recovered).toBe(2);
  expect(result.abandoned).toBe(1);
});

// A broken repair must not also stop new work: targets that are not wedged are unaffected by it.
test("still mints when the repair call fails", async () => {
  backlog.mockResolvedValue(["user-a"]);
  const require = vi.fn(async (_method: string, path: string) => {
    if (path === RECONCILE) throw new Error("reconciler offline");
    return { outcome: "minted" };
  });
  const api = { require: require as never };

  const result = await sweepCurator({ businessId: "biz", backlog, api, log });

  expect(result).toEqual({ recovered: 0, abandoned: 0, minted: 2, skipped: 0, failed: 0 });
  expect(log.error).toHaveBeenCalledWith(expect.stringContaining("reconciler offline"));
});

// Repair alone is worth a line: it means something crashed, which is never routine.
test("logs a sweep that only repaired", async () => {
  const api = makeApi({ outcome: "skipped" }, { recovered: 1, abandoned: 0 });
  await sweepCurator({ businessId: "biz", backlog, api, log });

  expect(log.info).toHaveBeenCalledWith(expect.stringContaining("recovered=1"));
});
