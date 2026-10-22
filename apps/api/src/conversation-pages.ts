import { createHash } from 'node:crypto';

export function conversationPage<T>(value: T, known?: string | null) {
  const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return { digest, ...(digest === known ? {} : { value }) };
}

/** Hash only the freshly authorized projection, never stored source content. */
export async function conversationPages<T, Cursor>(
  count: number,
  cursor: Cursor | null,
  known: readonly (string | null)[],
  load: (cursor: Cursor | null) => Promise<T>,
  next: (value: T) => Cursor | null,
) {
  const pages: { digest: string; value?: T }[] = [];
  for (let index = 0; index < count; index++) {
    const value = await load(cursor);
    pages.push(conversationPage(value, known[index]));
    cursor = next(value);
    if (cursor === null) break;
  }
  return { pages };
}
