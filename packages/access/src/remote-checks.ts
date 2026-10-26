import { AsyncLocalStorage } from 'node:async_hooks';
import { SourceAuthorizationUnavailable } from './index.ts';

type Outcome = { ok: true } | { ok: false; error: unknown };
type Scope = { outcomes: Map<string, Outcome>; pending: Map<string, () => Promise<void>>; inline: boolean };
type Budget = { deadline: number; checks: number; unavailable: boolean };
const scopes = new AsyncLocalStorage<Scope>();
const budgets = new AsyncLocalStorage<Budget>();

/**
 * What one call may spend on remote source checks, shared by every check it runs, including checks nested in other
 * checks. Once the time or check count is spent, or one source has been unavailable, the remaining sources are
 * reported unavailable without contacting the provider. Properties only so tests can shorten them.
 */
export const remoteSourceCheckLimits = { milliseconds: 10_000, checks: 32 };

function spent(budget: Budget) {
  return budget.unavailable || budget.checks >= remoteSourceCheckLimits.checks || Date.now() >= budget.deadline;
}

/**
 * Runs `operation` with one remote-check budget. Calls inside it, such as several `deferRemoteSourceChecks`, share
 * the budget instead of each starting their own; inside an existing budget, `operation` just runs.
 */
export function withRemoteSourceCheckBudget<T>(operation: () => Promise<T>): Promise<T> {
  if (budgets.getStore()) return operation();
  return budgets.run(
    { deadline: Date.now() + remoteSourceCheckLimits.milliseconds, checks: 0, unavailable: false },
    operation,
  );
}

/** When a remote check that starts now must give up: the shared budget's deadline, or `milliseconds` from now. */
export function remoteSourceCheckDeadline(milliseconds = remoteSourceCheckLimits.milliseconds) {
  return Math.min(Date.now() + milliseconds, budgets.getStore()?.deadline ?? Infinity);
}

/** Ends a transaction whose remote source checks still have to run. `deferRemoteSourceChecks` retries it. */
export class RemoteSourceChecksDeferred extends Error {
  constructor() {
    super('Remote source checks deferred');
  }
}

/**
 * Runs `operation` so that remote source checks, such as rereading a GitHub source, happen between its database
 * transactions instead of inside them, where they would hold authorization and account locks and a pooled connection
 * for as long as the provider takes. A transaction that meets an unchecked source rolls back; the check then runs
 * with no transaction open, and `operation` runs again with the outcome. Each source is checked once per call, and a
 * failed check fails the retried transaction exactly as an inline check would. `operation` must be safe to repeat:
 * only its last transaction commits. After `rounds` retries, remaining checks run inline so the call always ends.
 * All checks share one budget (see `remoteSourceCheckLimits`), so many slow sources cannot add up their timeouts.
 */
export async function deferRemoteSourceChecks<T>(operation: () => Promise<T>, rounds = 3): Promise<T> {
  if (scopes.getStore()) return operation();
  return withRemoteSourceCheckBudget(() => deferWithin(budgets.getStore()!, operation, rounds));
}

async function deferWithin<T>(budget: Budget, operation: () => Promise<T>, rounds: number): Promise<T> {
  const scope: Scope = { outcomes: new Map(), pending: new Map(), inline: false };
  return scopes.run(scope, async () => {
    for (let round = 0; ; round++) {
      scope.inline = round >= rounds;
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof RemoteSourceChecksDeferred) || !scope.pending.size) throw error;
      }
      const pending = [...scope.pending];
      scope.pending.clear();
      for (const [key, check] of pending) {
        if (spent(budget)) {
          scope.outcomes.set(key, { ok: false, error: new SourceAuthorizationUnavailable() });
          continue;
        }
        budget.checks++;
        try {
          await scopes.exit(check);
          scope.outcomes.set(key, { ok: true });
        } catch (error) {
          if (error instanceof SourceAuthorizationUnavailable) budget.unavailable = true;
          scope.outcomes.set(key, { ok: false, error });
        }
      }
    }
  });
}

/**
 * Called by a provider inside a transaction before it checks a source remotely. `inline` means check it now, as
 * before. `verified` means `check` passed earlier in this call, so only cheap database revalidation is left; a failed
 * earlier check is rethrown here. `deferred` means `check` will run after this transaction, which the provider must
 * then end with `RemoteSourceChecksDeferred`; treat the source as allowed until then, since nothing commits. Once the
 * call's budget is spent, an unchecked source throws `SourceAuthorizationUnavailable` instead.
 */
export function remoteSourceCheck(key: string, check: () => Promise<void>): 'inline' | 'verified' | 'deferred' {
  const scope = scopes.getStore();
  const outcome = scope?.outcomes.get(key);
  if (outcome) {
    if (!outcome.ok) throw outcome.error;
    return 'verified';
  }
  const budget = budgets.getStore();
  if (budget && spent(budget)) throw new SourceAuthorizationUnavailable();
  if (!scope || scope.inline) {
    if (budget) budget.checks++;
    return 'inline';
  }
  scope.pending.set(key, check);
  return 'deferred';
}
