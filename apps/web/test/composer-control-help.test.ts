import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const composer = readFileSync(new URL('../src/features/chat/composer.tsx', import.meta.url), 'utf8');

test('composer controls explain themselves with shared tooltips', () => {
  assert.match(composer, /TooltipTrigger render=\{<SelectTrigger size="sm" aria-label="Chat mode" \/>\}/);
  assert.match(
    composer,
    /<TooltipContent>Normal acts on your request\. Plan only proposes steps first\.<\/TooltipContent>/,
  );
  assert.match(
    composer,
    /render=\{<TooltipTrigger render=\{<InputGroupButton size="md" variant="ghost" disabled=\{off\} \/>\} \/>\}/,
  );
  assert.match(composer, /<TooltipContent>AI model that writes replies<\/TooltipContent>/);
  assert.match(composer, /<TooltipContent>Skills are saved procedures the agent follows · \/<\/TooltipContent>/);
});
