export type HookType = "before" | "after";

/** Resource before/after hook (original shape — `kind` absent for compatibility). */
export interface ResourceHookRequest {
  id: number;
  kind?: "resource-hook";
  hookType: HookType;
  hookSource: string;
  resourceType: string;
  record: Record<string, unknown>;
}

/**
 * Routine data-flow expression (ROUT-V1-007): a bare JS expression evaluated against
 * `scope`'s keys as locals. 100ms budget, no host callbacks at all.
 */
export interface ExpressionRequest {
  id: number;
  kind: "expression";
  code: string;
  scope: Record<string, unknown>;
}

/**
 * Routine hooks.ts function call: `hookSource` is the object-literal expression
 * (`({ beforeHook(ctx){}, myFn(ctx, args){} })`); `fnName` selects the function.
 */
export interface RoutineHookRequest {
  id: number;
  kind: "routine-hook";
  hookSource: string;
  fnName: string;
  invocation: Record<string, unknown>;
  args?: unknown;
  /** Lifecycle hooks (beforeX / afterX) are optional: a missing fn is a no-op, not an error. */
  optional?: boolean;
}

export type WorkerRequest = ResourceHookRequest | ExpressionRequest | RoutineHookRequest;

export type WorkerResponse =
  | { id: number; ok: true; record: Record<string, unknown> }
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string; timedOut?: boolean };
