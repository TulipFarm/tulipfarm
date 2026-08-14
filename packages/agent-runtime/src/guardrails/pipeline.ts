export const GUARD_TIMEOUT_MS = 5_000;

export type Verdict<T> =
  | { action: "pass" }
  | { action: "transform"; value: T }
  | { action: "block"; reason: string; message?: string };

export interface GuardContext {
  userId: string;
  agentId?: string;
  conversationId: string;
  autonomy?: string;
}

export type FailMode = "open" | "closed";

export interface Guard<T> {
  name: string;
  /** Guard failure mode: fail open for availability, fail closed for critical safety. */
  failMode?: FailMode;
  run(input: T, ctx: GuardContext): Promise<Verdict<T>> | Verdict<T>;
}

export type StageResult<T> =
  | { blocked: false; value: T }
  | { blocked: true; guard: string; reason: string; message?: string };

interface StageLogger {
  warn: (obj: unknown, msg?: string) => void;
}

const TIMEOUT = Symbol("guard-timeout");

/** Runs guards in order with timeout; transform feeds the next guard, block short-circuits. */
export async function runStage<T>(
  guards: Guard<T>[],
  input: T,
  ctx: GuardContext,
  log: StageLogger
): Promise<StageResult<T>> {
  let value = input;

  for (const g of guards) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), GUARD_TIMEOUT_MS);
    });

    let verdict: Verdict<T> | typeof TIMEOUT;
    try {
      verdict = await Promise.race([Promise.resolve(g.run(value, ctx)), timeout]);
    } catch (err) {
      if (g.failMode === "closed") {
        log.warn({ guard: g.name, err }, "guardrail guard errored — blocking (failMode: closed)");
        clearTimeout(timer);
        return { blocked: true, guard: g.name, reason: "guard_error" };
      }
      log.warn({ guard: g.name, err }, "guardrail guard skipped");
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (verdict === TIMEOUT) {
      if (g.failMode === "closed") {
        log.warn(
          { guard: g.name, timeoutMs: GUARD_TIMEOUT_MS },
          "guardrail guard timed out — blocking (failMode: closed)"
        );
        return { blocked: true, guard: g.name, reason: "guard_timeout" };
      }
      log.warn({ guard: g.name, timeoutMs: GUARD_TIMEOUT_MS }, "guardrail guard skipped");
      continue;
    }

    if (verdict.action === "transform") {
      value = verdict.value;
      continue;
    }

    if (verdict.action === "block") {
      return {
        blocked: true,
        guard: g.name,
        reason: verdict.reason,
        message: verdict.message,
      };
    }
  }

  return { blocked: false, value };
}
