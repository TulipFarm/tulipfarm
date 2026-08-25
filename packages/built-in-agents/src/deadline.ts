/**
 * Making a declared `timeoutMs` mean the whole operation.
 *
 * A BuiltInAgent's deadline is only honest if it covers everything the call does. Resolving a
 * model is not free — in the Worker it can cross a process boundary — so an agent that awaits
 * resolution first and only then arms `AbortSignal.timeout` has a budget that starts late and a
 * ceiling it does not actually enforce.
 */

/**
 * Stop waiting on `work` when `signal` aborts.
 *
 * The underlying work is not cancelled — nothing here can cancel it — so this bounds the wait,
 * not the effort. That is the right trade for model resolution: the caller gets its deadline back
 * and the abandoned lookup settles unobserved.
 *
 * @throws the signal's abort reason if the deadline wins.
 */
export function withDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  // Once the deadline wins, nothing is listening to `work`. An unobserved rejection is fatal under
  // Node's default policy, so it is observed here and discarded.
  work.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
