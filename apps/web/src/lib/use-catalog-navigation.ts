import { useState } from 'react';

type Position = { search: string; cursors: string[] };
const positions = new Map<string, Position>();

export function useCatalogNavigation(key: string) {
  const [position, setPosition] = useState<Position>(() => positions.get(key) ?? { search: '', cursors: [] });
  function update(next: Position) {
    positions.set(key, next);
    setPosition(next);
  }
  return {
    search: position.search,
    after: position.cursors.at(-1),
    page: position.cursors.length + 1,
    setSearch: (search: string) => update({ search, cursors: [] }),
    first: () => update({ ...position, cursors: [] }),
    previous: () => update({ ...position, cursors: position.cursors.slice(0, -1) }),
    next: (cursor: string) => update({ ...position, cursors: [...position.cursors, cursor] }),
  };
}
