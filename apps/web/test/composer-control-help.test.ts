import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const composer = readFileSync(new URL('../src/features/chat/composer.tsx', import.meta.url), 'utf8');
const modelPicker = readFileSync(new URL('../src/features/chat/model-picker.tsx', import.meta.url), 'utf8');

test('composer controls explain themselves with shared tooltips', () => {
  assert.match(composer, /<TooltipContent>Mode<\/TooltipContent>/);
  assert.match(composer, /<TooltipContent>Add files and more<\/TooltipContent>/);
  assert.match(composer, /<TooltipContent>Plan proposes steps before it acts\. Select to turn off\.<\/TooltipContent>/);
  assert.match(modelPicker, /<TooltipTrigger\s+render=\{\s*<DropdownMenuTrigger/);
  assert.match(modelPicker, /<TooltipContent>AI model that writes replies, and where it runs<\/TooltipContent>/);
});
