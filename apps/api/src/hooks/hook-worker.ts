import { createHash, randomUUID } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import ivm from "isolated-vm";
import { Pool } from "pg";
import { rowToResourceDoc, tableName } from "../resources/schema";
import type {
  ExpressionRequest,
  ResourceHookRequest,
  RoutineHookRequest,
  WorkerRequest,
  WorkerResponse,
} from "./types.js";

const HOOK_TIMEOUT_MS = 2000;
/** Routine data-flow expressions get a much tighter budget (ROUT-V1-007). */
const EXPRESSION_TIMEOUT_MS = 100;
const MEMORY_LIMIT_MB = 128;

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: workerData.connectionString as string });
  }
  return pool;
}

function docToRecord(doc: Record<string, unknown>): Record<string, unknown> {
  const { _id, ...rest } = doc as { _id: string } & Record<string, unknown>;
  const out: Record<string, unknown> = { id: _id, ...rest };
  if (out.createdAt instanceof Date) out.createdAt = out.createdAt.toISOString();
  if (out.updatedAt instanceof Date) out.updatedAt = out.updatedAt.toISOString();
  if (out.deletedAt instanceof Date) out.deletedAt = out.deletedAt.toISOString();
  return out;
}

/** Deterministic-time / seeded-random preamble shared by every sandbox variant. */
function determinismPreamble(now: number): string {
  const seed = (now ^ 0xdeadbeef) >>> 0;
  return `
  Date.now = () => ${now};
  let __rng__ = ${seed};
  Math.random = function() {
    __rng__ ^= __rng__ << 13;
    __rng__ ^= __rng__ >>> 17;
    __rng__ ^= __rng__ << 5;
    return (__rng__ >>> 0) / 4294967296;
  };`;
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Evaluate a routine data-flow expression: scope keys become locals, the expression's
 * value is copied back out. No host callbacks are installed — the isolate has no
 * host/fs/net reach at all.
 */
async function runExpression(req: ExpressionRequest): Promise<WorkerResponse> {
  const { id, code, scope } = req;
  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
  try {
    const context = await isolate.createContext();
    const keys = Object.keys(scope).filter((k) => IDENTIFIER_RE.test(k));
    const values = keys.map((k) => JSON.stringify(scope[k] ?? null));
    const script = await isolate.compileScript(`
(() => {
  ${determinismPreamble(Date.now())}
  return ((${keys.join(", ")}) => (${code}))(${values.join(", ")});
})()
`);
    const value = await script.run(context, { timeout: EXPRESSION_TIMEOUT_MS, copy: true });
    return { id, ok: true, value: value ?? null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { id, ok: false, error: msg, timedOut: msg.includes("execution timed out") };
  } finally {
    try {
      isolate.dispose();
    } catch {
      // dispose is best-effort
    }
  }
}

/**
 * Call one function from a routine's hooks.ts object literal
 * (`({ beforeHook(ctx){}, myFn(ctx, args){} })`). Gets hash/uuid helpers on ctx like
 * resource hooks, but no patch/resource access — hooks compute, they don't write.
 */
async function runRoutineHook(req: RoutineHookRequest): Promise<WorkerResponse> {
  const { id, hookSource, fnName, invocation, args, optional } = req;
  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
  try {
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set(
      "__hash__",
      new ivm.Callback((str: string) => createHash("sha256").update(str).digest("hex"), {
        sync: true,
      })
    );
    await jail.set("__uuid__", new ivm.Callback(() => randomUUID(), { sync: true }));

    const script = await isolate.compileScript(`
(async () => {
  ${determinismPreamble(Date.now())}
  const ctx = Object.freeze({
    ...(${JSON.stringify(invocation)}),
    hash: __hash__,
    uuid: __uuid__,
  });
  const __hookDef__ = (${hookSource});
  const __fn__ = __hookDef__[${JSON.stringify(fnName)}];
  if (typeof __fn__ !== 'function') {
    if (${optional === true}) return null;
    throw new Error('hooks.ts does not define function "' + ${JSON.stringify(fnName)} + '"');
  }
  return await __fn__(ctx, ${JSON.stringify(args ?? null)});
})()
`);
    const value = await script.run(context, {
      timeout: HOOK_TIMEOUT_MS,
      promise: true,
      copy: true,
    });
    return { id, ok: true, value: value ?? null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { id, ok: false, error: msg, timedOut: msg.includes("execution timed out") };
  } finally {
    try {
      isolate.dispose();
    } catch {
      // dispose is best-effort
    }
  }
}

async function runHook(req: ResourceHookRequest): Promise<WorkerResponse> {
  const { id, hookType, hookSource, record } = req;
  const patchData: Record<string, unknown> = {};

  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
  try {
    const context = await isolate.createContext();
    const jail = context.global;

    await jail.set(
      "__patch__",
      new ivm.Callback(
        (obj: Record<string, unknown>) => {
          Object.assign(patchData, obj);
        },
        { sync: true }
      )
    );

    await jail.set(
      "__hash__",
      new ivm.Callback((str: string) => createHash("sha256").update(str).digest("hex"), {
        sync: true,
      })
    );

    await jail.set("__uuid__", new ivm.Callback(() => randomUUID(), { sync: true }));

    await jail.set(
      "__getResource__",
      new ivm.Callback(
        async (type: string, resId: string) => {
          let table: string;
          try {
            table = tableName(type);
          } catch {
            return null; // unknown / invalid resource type
          }
          const { rows } = await getPool().query<Record<string, unknown>>(
            `SELECT id, version, created_at, updated_at, deleted_at, data
             FROM ${table} WHERE id = $1 AND deleted_at IS NULL`,
            [resId]
          );
          if (!rows[0]) return null;
          return new ivm.ExternalCopy(docToRecord(rowToResourceDoc(rows[0])));
        },
        { async: true }
      )
    );

    const recordJson = JSON.stringify(record);
    const now = Date.now();
    const seed = (now ^ 0xdeadbeef) >>> 0;

    const script = await isolate.compileScript(`
(async () => {
  Date.now = () => ${now};
  let __rng__ = ${seed};
  Math.random = function() {
    __rng__ ^= __rng__ << 13;
    __rng__ ^= __rng__ >>> 17;
    __rng__ ^= __rng__ << 5;
    return (__rng__ >>> 0) / 4294967296;
  };
  const ctx = Object.freeze({
    record: ${recordJson},
    patch: __patch__,
    resources: Object.freeze({ get: __getResource__ }),
    hash: __hash__,
    uuid: __uuid__,
    now: ${now},
  });
  const __hookDef__ = (${hookSource});
  const __hookFn__ = __hookDef__[${JSON.stringify(hookType)}];
  if (typeof __hookFn__ === 'function') {
    await __hookFn__(ctx);
  }
})()
`);

    await script.run(context, { timeout: HOOK_TIMEOUT_MS, promise: true });

    const result = hookType === "before" ? { ...record, ...patchData } : record;
    return { id, ok: true, record: result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut = msg.includes("execution timed out");
    return { id, ok: false, error: msg, timedOut };
  } finally {
    try {
      isolate.dispose();
    } catch {
      // dispose is best-effort
    }
  }
}

async function shutdown() {
  if (pool) {
    await pool.end().catch(() => {});
  }
}

parentPort?.on("message", async (req: WorkerRequest) => {
  if ((req as unknown as { type?: string }).type === "shutdown") {
    await shutdown();
    process.exit(0);
  }
  let res: WorkerResponse;
  if (req.kind === "expression") {
    res = await runExpression(req);
  } else if (req.kind === "routine-hook") {
    res = await runRoutineHook(req);
  } else {
    res = await runHook(req);
  }
  parentPort?.postMessage(res);
});
