import { Button } from '@tulipfarm/sprout/button';
import type { ReadState } from '@/features/tables/request-state';

export function ReferenceName({
  noun,
  name,
  state,
  refresh,
}: {
  noun: string;
  name: string | null;
  state: ReadState<unknown>;
  refresh: () => Promise<void>;
}) {
  const pending = state.kind === 'loading' || (state.kind === 'ready' && state.refreshing);
  if (state.kind === 'loading') return <span role="status">Loading {noun.toLowerCase()} name…</span>;
  const failed = state.kind === 'error' || (state.kind === 'ready' && !!state.error);
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1 wrap-anywhere">
      <span className="min-w-0">
        {state.kind === 'ready' && name ? name : failed ? `${noun} name could not load` : `${noun} name unavailable`}
      </span>
      {failed && name && state.kind === 'ready' && <span role="alert">Could not refresh this name.</span>}
      {(failed || !name || state.kind === 'unavailable') && (
        <Button variant="ghost" size="sm" disabled={pending} aria-busy={pending} onClick={() => void refresh()}>
          Check {noun.toLowerCase()} name again
        </Button>
      )}
    </span>
  );
}
