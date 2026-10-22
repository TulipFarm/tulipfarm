import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPageReuse, readPageWindow } from '../src/features/chat/page-reuse.ts';

type Page = { rows: string[]; next: number | null };
const next = (page: Page) => page.next;
const signal = () => new AbortController().signal;

test('page reuse requires current server validation and replaces changed pages and cursor chains', async () => {
  const reuse = createPageReuse<Page>();
  let pages = Array.from({ length: 5 }, (_, index) => ({ rows: [`row-${index}`], next: index < 4 ? index + 1 : null }));
  const requests: { cursor: number | null; count: number; known: readonly (string | null)[] }[] = [];
  const load = async (cursor: number | null, count: number, known: readonly (string | null)[]) => {
    requests.push({ cursor, count, known });
    return pages.slice(cursor ?? 0, (cursor ?? 0) + count).map((value, index) => {
      const digest = JSON.stringify(value);
      return { digest, ...(known[index] === digest ? {} : { value: structuredClone(value) }) };
    });
  };
  for (let depth = 1; depth <= 5; depth++) {
    assert.deepEqual(await readPageWindow(depth, signal(), reuse, load, next), pages.slice(0, depth));
  }
  assert.equal(requests.length, 5);
  assert.deepEqual(
    requests.map(request => request.known.length),
    [0, 1, 2, 3, 4],
  );
  const old = reuse.pages[1].value;
  assert.deepEqual(await readPageWindow(5, signal(), reuse, load, next), pages);
  assert.equal(reuse.pages[1].value, old, 'unchanged pages retain their object identity only after validation');
  pages[1] = { ...pages[1], rows: ['Source unavailable'] };
  assert.deepEqual(await readPageWindow(5, signal(), reuse, load, next), pages, 'old source content is replaced');
  pages = [
    { rows: ['new'], next: 1 },
    { rows: ['last'], next: null },
  ];
  assert.deepEqual(await readPageWindow(5, signal(), reuse, load, next), pages, 'deleted pages do not survive');
  assert.equal(reuse.pages.length, 2);
});

test('long windows are chunked without a history cap and retain at most five pages', async () => {
  const reuse = createPageReuse<Page>();
  const calls: number[] = [];
  const result = await readPageWindow(
    12,
    signal(),
    reuse,
    async (cursor: number | null, count, known) => {
      calls.push(count);
      assert.equal(known.length, 0);
      return Array.from({ length: count }, (_, index) => {
        const sequence = (cursor ?? 0) + index + 1;
        return { digest: String(sequence), value: { rows: [String(sequence)], next: sequence } };
      });
    },
    next,
  );
  assert.equal(result.length, 12);
  assert.deepEqual(calls, [5, 5, 2]);
  assert.equal(reuse.pages.length, 5);
});

test('failed, denied, cancelled, or invalid validation never publishes partial reused pages', async () => {
  for (const failure of [new Error('offline'), Object.assign(new Error('denied'), { status: 403 })]) {
    const reuse = createPageReuse<Page>();
    reuse.pages = [{ digest: 'old', value: { rows: ['old source'], next: 1 } }];
    await assert.rejects(
      readPageWindow(
        2,
        signal(),
        reuse,
        async () => {
          throw failure;
        },
        next,
      ),
      error => error === failure,
    );
    assert.deepEqual(reuse.pages, []);
  }
  const reuse = createPageReuse<Page>();
  await assert.rejects(
    readPageWindow(1, signal(), reuse, async () => [{ digest: 'unknown' }], next),
    /not validated/,
  );
  await assert.rejects(
    readPageWindow(2, signal(), reuse, async () => [{ digest: 'one', value: { rows: [], next: 1 } }], next),
    /Incomplete/,
  );
  const controller = new AbortController();
  await assert.rejects(
    readPageWindow(
      1,
      controller.signal,
      reuse,
      async () => {
        controller.abort(new Error('identity changed'));
        return [{ digest: 'old-user', value: { rows: ['private'], next: null } }];
      },
      next,
    ),
    /identity changed/,
  );
  assert.deepEqual(reuse.pages, []);
});

test('an older overlapping read cannot replace the newer validated window', async () => {
  const reuse = createPageReuse<Page>();
  let release!: (value: { digest: string; value: Page }[]) => void;
  const older = readPageWindow(
    1,
    signal(),
    reuse,
    () =>
      new Promise(resolve => {
        release = resolve;
      }),
    next,
  );
  const fresh = { digest: 'new', value: { rows: ['new'], next: null } };
  await readPageWindow(1, signal(), reuse, async () => [fresh], next);
  release([{ digest: 'old', value: { rows: ['old'], next: null } }]);
  await older;
  assert.deepEqual(reuse.pages, [fresh]);
});
