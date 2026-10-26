type DuePlan = { id: string; version: number; quiet: boolean; liveOwners?: number };
type Entry = { state: string; wokeAt: number; delay: number };

/**
 * Decides which active plans the recovery loop wakes. A plan with an open attempt is woken on every pass, so a lost
 * wake costs at most a pass. A quiet plan, whose only open attempts, if any, wait to recheck their sources until a
 * later time, cannot progress until something changes: a change to the plan bumps its version and is woken at once,
 * and so does a change in how many of its owner turns are still running, since a planning plan whose owners have all
 * ended is paused by its next step. A change outside it, such as restored access, is only seen by advancing again.
 * So while both stay the same, a quiet plan is woken after exponentially growing intervals.
 * The state is per process; a restart only makes the next pass wake each plan once more.
 */
export function createPlanRecoveryBackoff(options: { initial?: number; maximum?: number; now?: () => number } = {}) {
  const initial = options.initial ?? 60_000;
  const maximum = options.maximum ?? 60 * 60_000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  let pruned = 0;
  return {
    due(plan: DuePlan) {
      const at = now();
      if (at - pruned >= maximum) {
        for (const [id, entry] of entries) if (at - entry.wokeAt > 2 * maximum) entries.delete(id);
        pruned = at;
      }
      if (!plan.quiet) {
        entries.delete(plan.id);
        return true;
      }
      const state = `${plan.version}:${plan.liveOwners ?? 0}`;
      const entry = entries.get(plan.id);
      if (!entry || entry.state !== state) {
        entries.set(plan.id, { state, wokeAt: at, delay: initial });
        return true;
      }
      if (at < entry.wokeAt + entry.delay) return false;
      entries.set(plan.id, { state, wokeAt: at, delay: Math.min(entry.delay * 2, maximum) });
      return true;
    },
  };
}
