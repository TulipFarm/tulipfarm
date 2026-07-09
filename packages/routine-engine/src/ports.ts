import type { RunEvent, RunSnapshot } from "./types";

/** Hook invocation context passed to hooks.ts functions (mirrors resource hooks). */
export interface HookInvocation {
  runId: string;
  slug: string;
  stateName?: string;
  context: Record<string, unknown>;
  trigger: { type: string; payload?: unknown };
}

/** Resolved `functions[]` entry: `tool:x` | `agent:x` | `hook:x`. */
export interface ResolvedFunction {
  kind: "tool" | "agent" | "hook";
  target: string;
}

/**
 * Everything the interpreter needs from the outside world. All adapters (isolated-vm,
 * ToolRegistry, agent turns, journal/SSE) live in apps/api — this package never imports
 * Fastify or pg-boss.
 */
export interface EnginePorts {
  /** Evaluate a JS expression in the sandbox (100ms, no host/fs/net). */
  evalExpression(expr: string, scope: Record<string, unknown>): Promise<unknown>;
  /** Run a hooks.ts function (2s sandbox). Only called when the routine has hooks. */
  runHook(fnName: string, invocation: HookInvocation, args?: unknown): Promise<unknown>;
  /** Whether the routine's hooks.ts defines `fnName`. False when there is no hooks.ts. */
  hasHook(fnName: string): boolean;
  /** Execute a tool or agent action. Throws on failure (interpreter maps to retry/onErrors). */
  runAction(
    fn: ResolvedFunction,
    args: Record<string, unknown>,
    run: RunSnapshot
  ): Promise<unknown>;
  /** Journal + fan out a run event. */
  emit(event: RunEvent): Promise<void>;
  now(): Date;
  log: { warn(msg: string): void };
}
