import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import type * as ProposalCard from '../src/features/chat/table-proposal-card.tsx';
import type { ImportAdjustment } from '../src/features/tables/review-contracts.ts';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
after(() => server.close());
const { importAdjustmentText } = (await server.ssrLoadModule(
  '/src/features/chat/table-proposal-card.tsx',
)) as typeof ProposalCard;

test('the import review lists each change made to fit the file in plain words', () => {
  const adjustments: ImportAdjustment[] = [
    { kind: 'delimiter', requested: ',', used: ';' },
    { kind: 'sheet', requested: 'Sheet1', used: 'Orders', only: true },
    { kind: 'sheet', requested: 'orders', used: 'Orders', only: false },
    { kind: 'column', requested: 'order id', used: 'Order ID' },
    { kind: 'conversion-dropped', column: 'Total', conversion: 'numeric' },
    { kind: 'conversion-changed', column: 'Placed', requested: 'date', used: 'timestamp', example: '2026-01-02T10:00' },
  ];
  assert.deepEqual(adjustments.map(importAdjustmentText), [
    'Read the file using semicolons (;) instead of commas (,).',
    'Used "Orders", the only sheet in the file.',
    'Used the sheet "Orders" for "orders".',
    'Matched "order id" to the column "Order ID".',
    'Didn\'t convert "Total" to a number because the file has no column with that name.',
    'Kept "Placed" as a date and time instead of a date because some values, like "2026-01-02T10:00", don\'t fit.',
  ]);
});
