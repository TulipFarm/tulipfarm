import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const composer = readFileSync(new URL('../src/features/chat/composer.tsx', import.meta.url), 'utf8');

test('composer controls explain themselves with shared tooltips', () => {
  assert.match(composer, /<TooltipContent>Mode<\/TooltipContent>/);
  assert.match(composer, /<TooltipContent>Add files and more<\/TooltipContent>/);
  assert.match(composer, /<TooltipContent>Plan proposes steps before it acts\. Select to turn off\.<\/TooltipContent>/);
  assert.match(
    composer,
    /render=\{<TooltipTrigger render=\{<InputGroupButton size="md" variant="ghost" disabled=\{off\} \/>\} \/>\}/,
  );
  assert.match(composer, /<TooltipContent>AI model that writes replies<\/TooltipContent>/);
});
