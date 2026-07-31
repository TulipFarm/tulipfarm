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

export interface Guard<T> {
  name: string;
  run(input: T, ctx: GuardContext): Promise<Verdict<T>> | Verdict<T>;
}

export type StageResult<T> =
  | { blocked: false; value: T }
  | { blocked: true; guard: string; reason: string; message?: string };

interface StageLogger {
  warn: (obj: unknown, msg?: string) => void;
}

const TIMEOUT = Symbol("guard-timeout");

/**
 * Runs guards in array order over a single stage.
 *
 * Each guard runs under a {@link GUARD_TIMEOUT_MS} timeout. On timeout or a
 * thrown error the guard is skipped (treated as `pass`) and a warning is logged
 * so a slow or buggy guard can never crash or stall the turn. A `transform`
 * verdict feeds its value into the next guard; the first `block` short-circuits.
 */
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
      log.warn({ guard: g.name, err }, "guardrail guard skipped");
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (verdict === TIMEOUT) {
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
