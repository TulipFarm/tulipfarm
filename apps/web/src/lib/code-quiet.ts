// Resource timing has no in-flight list, so quiet means no script, style or font finished
// for a while. ponytail: a single file downloading longer than the window looks quiet.
const quietMs = 1500;
const capMs = 30_000;
const apiCalls = new Set(['fetch', 'xmlhttprequest', 'beacon']);
let quiet: Promise<void> | undefined;

/** Resolves once the page has stopped downloading code, so optional downloads never delay it. */
export function whenCodeQuiet(): Promise<void> {
  quiet ??= new Promise(resolve => {
    if (typeof PerformanceObserver === 'undefined') return resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      clearTimeout(cap);
      observer.disconnect();
      resolve();
    };
    const wait = () => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    };
    const cap = setTimeout(done, capMs);
    const observer = new PerformanceObserver(list => {
      if (list.getEntries().some(entry => !apiCalls.has((entry as PerformanceResourceTiming).initiatorType))) wait();
    });
    observer.observe({ type: 'resource' });
    if (document.readyState === 'complete') wait();
    else window.addEventListener('load', wait, { once: true });
  });
  return quiet;
}
