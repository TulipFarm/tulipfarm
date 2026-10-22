export type PageReply<T> = { digest: string; value?: T | undefined };
export type PageReuse<T> = { generation: number; pages: { digest: string; value: T }[] };
export const createPageReuse = <T>(): PageReuse<T> => ({ generation: 0, pages: [] });
export const pageWindowSize = 5;

export async function readPageWindow<T, Cursor>(
  count: number,
  signal: AbortSignal,
  reuse: PageReuse<T>,
  load: (cursor: Cursor | null, count: number, known: readonly (string | null)[]) => Promise<PageReply<T>[]>,
  next: (page: T) => Cursor | null,
) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid chat page count');
  const generation = ++reuse.generation;
  const previous = reuse.pages;
  const retained: PageReuse<T>['pages'] = [];
  const values: T[] = [];
  let cursor: Cursor | null = null;
  try {
    while (values.length < count) {
      const offset = values.length;
      const size = Math.min(pageWindowSize, count - offset);
      const known = previous.slice(offset, offset + size);
      const result = await load(
        cursor,
        size,
        known.map(page => page.digest),
      );
      signal.throwIfAborted();
      if (!result.length || result.length > size) throw new Error('Invalid chat page window');
      for (const [index, page] of result.entries()) {
        const cached = known[index];
        const value = page.value ?? (cached?.digest === page.digest ? cached.value : undefined);
        if (value === undefined) throw new Error('Chat page was not validated');
        values.push(value);
        if (retained.length < pageWindowSize) retained.push({ digest: page.digest, value });
        cursor = next(value);
        if (cursor === null && index !== result.length - 1) throw new Error('Invalid chat page continuation');
      }
      if (cursor === null) break;
      if (result.length < size) throw new Error('Incomplete chat page window');
    }
    if (reuse.generation === generation) reuse.pages = retained;
    return values;
  } catch (error) {
    if (reuse.generation === generation) reuse.pages = [];
    throw error;
  }
}
