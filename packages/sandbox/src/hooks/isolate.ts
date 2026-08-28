import { createHash, randomUUID } from "node:crypto";
import ivm from "isolated-vm";
import type {
  ExpressionRequest,
  ResourceHookRequest,
  RoutineHookRequest,
  WorkerResponse,
} from "./protocol";

const HOOK_TIMEOUT_MS = 2000;
/** Routine data-flow expressions get a much tighter budget (ROUT-V1-007). */
const EXPRESSION_TIMEOUT_MS = 100;
const MEMORY_LIMIT_MB = 128;

/** Optional host read capability for resource hooks; absent means no reach outside the isolate. */
/** Hook modules are parenthesized object expressions; trim trailing `;` before wrapping. */
export function hookExpression(source: string): string {
  return source.replace(/;\s*$/, "");
}

export type ResourceLookup = (
  resourceType: string,
  resourceId: string
) => Promise<Record<string, unknown> | null>;

/** Deterministic time/random makes hook replay evidence, not a fresh roll. */
function determinismPreamble(now: number, seed?: string): string {
  // A seeded caller gets the same stream on every attempt of its occurrence; an unseeded one only
  // gets a frozen clock, since there is nothing stable to derive a stream from.
  const rngSeed =
    seed === undefined
      ? (now ^ 0xdeadbeef) >>> 0
      : (Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) || 1) >>>
        0;
  return `
  Date.now = () => ${now};
  let __rng__ = ${rngSeed === 0 ? 1 : rngSeed};
  Math.random = function() {
    __rng__ ^= __rng__ << 13;
    __rng__ ^= __rng__ >>> 17;
    __rng__ ^= __rng__ << 5;
    return (__rng__ >>> 0) / 4294967296;
  };`;
}

/**
 * A uuid generator that repeats itself across attempts of the same occurrence.
 *
 * Shaped as a v4 uuid so nothing downstream has to special-case it, but derived from the seed and
 * a call counter, so the nth `ctx.uuid()` of a retried State is the id the first attempt made.
 */
function seededUuids(seed: string): () => string {
  let counter = 0;
  return () => {
    const digest = createHash("sha256").update(`${seed}:${counter}`).digest("hex");
    counter += 1;
    const variant = ((Number.parseInt(digest.slice(16, 18), 16) & 0x3f) | 0x80)
      .toString(16)
      .padStart(2, "0");
    return [
      digest.slice(0, 8),
      digest.slice(8, 12),
      `4${digest.slice(13, 16)}`,
      `${variant}${digest.slice(18, 20)}`,
      digest.slice(20, 32),
    ].join("-");
  };
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function failure(id: number, err: unknown): WorkerResponse {
  const msg = err instanceof Error ? err.message : String(err);
  return { id, ok: false, error: msg, timedOut: msg.includes("execution timed out") };
}

function dispose(isolate: ivm.Isolate): void {
  try {
    isolate.dispose();
  } catch {
    // dispose is best-effort
  }
}

/** Evaluate a data-flow expression with scope locals and no host/fs/net reach. */
export async function runExpression(req: ExpressionRequest): Promise<WorkerResponse> {
  const { id, code, scope, determinismSeed } = req;
  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
  try {
    const context = await isolate.createContext();
    const keys = Object.keys(scope).filter((k) => IDENTIFIER_RE.test(k));
    const values = keys.map((k) => JSON.stringify(scope[k] ?? null));
    const script = await isolate.compileScript(`
(() => {
  ${determinismPreamble(Date.now(), determinismSeed)}
  return ((${keys.join(", ")}) => (${code}))(${values.join(", ")});
})()
`);
    const value = await script.run(context, { timeout: EXPRESSION_TIMEOUT_MS, copy: true });
    return { id, ok: true, value: value ?? null };
  } catch (err) {
    return failure(id, err);
  } finally {
    dispose(isolate);
  }
}

/** Call a Routine hook with hash/uuid helpers but no patch/resource access. */
export async function runRoutineHook(req: RoutineHookRequest): Promise<WorkerResponse> {
  const { id, hookSource, fnName, invocation, args, optional, determinismSeed } = req;
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
    const uuid = determinismSeed === undefined ? randomUUID : seededUuids(determinismSeed);
    await jail.set("__uuid__", new ivm.Callback(() => uuid(), { sync: true }));

    const script = await isolate.compileScript(`
(async () => {
  ${determinismPreamble(Date.now(), determinismSeed)}
  const ctx = Object.freeze({
    ...(${JSON.stringify(invocation)}),
    hash: __hash__,
    uuid: __uuid__,
  });
  const __hookDef__ = (${hookExpression(hookSource)});
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
    return failure(id, err);
  } finally {
    dispose(isolate);
  }
}

/** `before` may patch; `after` observes committed history and cannot edit it. */
export async function runResourceHook(
  req: ResourceHookRequest,
  lookup?: ResourceLookup
): Promise<WorkerResponse> {
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
          if (!lookup) return null;
          const found = await lookup(type, resId);
          return found ? new ivm.ExternalCopy(found) : null;
        },
        { async: true }
      )
    );

    const now = Date.now();
    const script = await isolate.compileScript(`
(async () => {
  ${determinismPreamble(now)}
  const ctx = Object.freeze({
    record: ${JSON.stringify(record)},
    patch: __patch__,
    resources: Object.freeze({ get: __getResource__ }),
    hash: __hash__,
    uuid: __uuid__,
    now: ${now},
  });
  const __hookDef__ = (${hookExpression(hookSource)});
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
    return failure(id, err);
  } finally {
    dispose(isolate);
  }
}
