import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chosenLabels, optionLabels } from '../src/features/chat/layout-labels.ts';

const deal = 'ec55d1f3-6015-5c9e-8ba9-6c2eac12d08a';
const owner = '5c88edcf-ebf7-4807-9838-82e56118dbe3';
const messages = [
  {
    updateComponents: {
      components: [
        { id: 'stage', component: 'ChoicePicker', options: [{ value: 'won', label: 'Closed won' }] },
        { id: 'region', component: 'ChoicePicker', options: [{ value: 'eu', label: { path: '/regionName' } }] },
      ],
    },
  },
  { agentFunctionResponse: { functionCallId: 'deals', value: [{ value: deal, label: 'Globex pilot' }] } },
  { agentFunctionResponse: { functionCallId: 'members', value: [{ value: owner, label: 'Dev User' }] } },
];

test('chosen options are sent with the labels the person saw, from lookups and fixed options', () => {
  assert.deepEqual(chosenLabels({ deal: [deal], owner, stage: ['won'] }, optionLabels(messages)), {
    deal: 'Globex pilot',
    owner: 'Dev User',
    stage: 'Closed won',
  });
});

test('values that are not chosen options, or only partly known, keep no label', () => {
  const labels = optionLabels(messages);
  assert.equal(chosenLabels({ note: 'Call Monday', count: 3, region: ['eu'] }, labels), undefined);
  assert.deepEqual(chosenLabels({ deal: [deal, 'unknown'], owner: [owner] }, labels), { owner: 'Dev User' });
});
