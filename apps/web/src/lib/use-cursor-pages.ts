import { useState } from 'react';

/** Cursors belong to one `scope`, such as a serialized search and sort; a new scope starts again at page 1. */
export function useCursorPages(scope = '', initialAfter?: string) {
  const initial = initialAfter ? [initialAfter] : [];
  const [state, setState] = useState<{ scope: string; cursors: string[] }>({ scope, cursors: initial });
  const cursors = state.scope === scope ? state.cursors : [];
  const update = (change: (cursors: string[]) => string[]) =>
    setState(current => ({ scope, cursors: change(current.scope === scope ? current.cursors : []) }));
  return {
    after: cursors.at(-1),
    page: cursors.length + 1,
    first: () => update(() => []),
    previous: () => update(current => current.slice(0, -1)),
    next: (cursor: string) => update(current => [...current, cursor]),
  };
}
