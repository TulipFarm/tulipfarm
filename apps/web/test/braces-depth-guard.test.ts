// Regression for GHSA-vfj7-8cjw-p6xm: braces is reached via shadcn > fast-glob > micromatch,
// and patches/braces@3.0.3.patch bounds parser and AST-walker recursion depth.
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const shadcnDir = realpathSync(new URL('../node_modules/shadcn/', import.meta.url));
const fromShadcn = createRequire(`${shadcnDir}/package.json`);
const fromFastGlob = createRequire(fromShadcn.resolve('fast-glob/package.json'));
const fromMicromatch = createRequire(fromFastGlob.resolve('micromatch/package.json'));

type Node = { type: string; value?: string; nodes?: Node[] };
type Braces = {
  (pattern: string, options?: object): string[];
  compile(input: Node, options?: object): string;
  expand(input: string | Node, options?: object): string[];
  stringify(input: Node, options?: object): string;
};

const braces = fromMicromatch('braces') as Braces;
const depthError = { name: 'RangeError', message: /exceeds max depth/ };

test('braces still expands ordinary patterns', () => {
  assert.deepEqual(braces.expand('a/{b,c}/{1..2}'), ['a/b/1', 'a/b/2', 'a/c/1', 'a/c/2']);
  assert.deepEqual(braces('{a,{b,c}}'), ['(a|(b|c))']);
});

test('parser rejects deeply nested braces before recursing', () => {
  const nested = `${'{'.repeat(4000)}a,b${'}'.repeat(4000)}`;
  assert.throws(() => braces.expand(nested), depthError);
  assert.throws(() => braces(nested), depthError);
});

test('compile, expand, and stringify reject deeply nested supplied ASTs', () => {
  let node: Node = { type: 'text', value: 'x' };
  for (let index = 0; index < 20000; index += 1) node = { type: 'brace', nodes: [node] };
  const ast: Node = { type: 'root', nodes: [node] };

  assert.throws(() => braces.compile(ast), depthError);
  assert.throws(() => braces.expand(ast), depthError);
  assert.throws(() => braces.stringify(ast), depthError);
});
