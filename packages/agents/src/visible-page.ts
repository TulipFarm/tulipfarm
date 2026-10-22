import { AccessDenied, SourceAuthorizationUnavailable } from '@tulipfarm/access';

export async function visiblePage<T extends { id: string }>(
  query: { after?: string | undefined; limit: number },
  load: (after: string | undefined, limit: number) => Promise<T[]>,
  authorize: (item: T) => Promise<void>,
) {
  const visible: T[] = [];
  let after = query.after;
  const deadline = Date.now() + 10000;
  for (let scanned = 0; scanned < 10000;) {
    const rows = await load(after, 100);
    for (const row of rows) {
      if (Date.now() >= deadline) throw new SourceAuthorizationUnavailable();
      scanned++;
      try {
        await authorize(row);
        visible.push(row);
      } catch (error) {
        if (!(error instanceof AccessDenied) || error instanceof SourceAuthorizationUnavailable) throw error;
      }
      if (visible.length > query.limit) {
        const items = visible.slice(0, query.limit);
        return { items, nextCursor: items.at(-1)?.id ?? null };
      }
    }
    if (rows.length < 100) return { items: visible, nextCursor: null };
    after = rows.at(-1)?.id;
  }
  throw new SourceAuthorizationUnavailable();
}
