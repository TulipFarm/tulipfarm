type Journey = 'workspace-admission' | 'chat-list';
type Outcome = 'ready' | 'error' | 'unavailable';
type Measurement = { journey: Journey; outcome: Outcome; duration_ms: number };
const listeners = new Set<(measurement: Measurement) => void>();

export function subscribeNavigationPerformance(listener: (measurement: Measurement) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function startNavigationMeasure(journey: Journey): (outcome: Outcome) => void {
  let local = false;
  try {
    local = sessionStorage.getItem('tulipfarm:performance') === '1';
  } catch {
    /* Local diagnostics are optional when browser storage is blocked. */
  }
  const subscribers = [...listeners];
  if (!local && !subscribers.length) return () => {};
  const start = performance.now();
  let finished = false;
  return outcome => {
    if (finished) return;
    finished = true;
    const end = performance.now();
    if (local) {
      const name = `tulipfarm:${journey}:${outcome}`;
      if (performance.getEntriesByName(name, 'measure').length >= 50) performance.clearMeasures(name);
      performance.measure(name, { start, end });
    }
    for (const listener of subscribers) {
      if (!listeners.has(listener)) continue;
      try {
        listener({ journey, outcome, duration_ms: end - start });
      } catch {
        console.warn('Browser performance capture failed');
      }
    }
  };
}

export async function measureWorkspaceAdmission<T>(read: () => Promise<T>): Promise<T> {
  const finish = startNavigationMeasure('workspace-admission');
  try {
    const result = await read();
    finish('ready');
    return result;
  } catch (error) {
    finish('error');
    throw error;
  }
}
