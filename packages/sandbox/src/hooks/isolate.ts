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

/**
 * The one host capability a resource hook may reach: read another record.
 *
 * It is injected rather than implemented here because the tables it reads belong to whichever
 * application owns them, and this package owns the isolation boundary, not the schema. A host
 * that passes nothing gets a sandbox with no reach out of the isolate at all — which is what the
 * classifier and expression paths want.
 */
/**
 * A hook module is an object-literal *expression*, and it is interpolated inside parentheses —
 * so a trailing `;`, which any formatter adds to a file that is also valid TypeScript, turns the
 * wrapper into a syntax error.
 *
 * Normalised here rather than forbidden in authoring, because the failure it causes is both
 * remote from its cause and total: every delivery to that integration fails to parse, and the
 * author's only clue is a column number inside generated code they never wrote.
 */
export function hookExpression(source: string): string {
  return source.replace(/;\s*$/, "");
}

export type ResourceLookup = (
  resourceType: string,
  resourceId: string
) => Promise<Record<string, unknown> | null>;

/**
 * Deterministic-time / seeded-random preamble shared by every sandbox variant. Two runs of the
 * same hook over the same record produce the same result, so a replay is evidence rather than a
 * fresh roll of the dice.
 */
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

/**
 * Evaluate a routine data-flow expression: scope keys become locals, the expression's
 * value is copied back out. No host callbacks are installed — the isolate has no
 * host/fs/net reach at all.
 */
export async function runExpression(req: ExpressionRequest): Promise<WorkerResponse> {
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
    return failure(id, err);
  } finally {
    dispose(isolate);
  }
}

/**
 * Call one function from a routine's hooks.ts object literal
 * (`({ beforeHook(ctx){}, myFn(ctx, args){} })`). Gets hash/uuid helpers on ctx like
 * resource hooks, but no patch/resource access — hooks compute, they don't write.
 */
export async function runRoutineHook(req: RoutineHookRequest): Promise<WorkerResponse> {
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

/**
 * Run a resource before/after hook. `before` collects `ctx.patch(...)` calls and returns the
 * patched record; `after` returns the record untouched — an after hook observes a write that
 * already happened, so letting it edit the record would be editing history.
 */
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
