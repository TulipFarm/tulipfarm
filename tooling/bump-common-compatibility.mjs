#!/usr/bin/env node
// Moves every common-compatibility pin from the previous stream head to a newly added migration.
// Usage: node tooling/bump-common-compatibility.mjs <previous-head.sql> <new-migration.sql> <previous-count>
// Prints each changed file. The storage-release Python fixture names each migration's package and stays a manual edit;
// review the remaining matches of the previous count and head name afterwards.
import { glob, readFile, writeFile } from 'node:fs/promises';

const [previous, added, countText] = process.argv.slice(2);
const count = Number(countText);
if (!previous?.endsWith('.sql') || !added?.endsWith('.sql') || !Number.isInteger(count)) {
  console.error(
    'Usage: node tooling/bump-common-compatibility.mjs <previous-head.sql> <new-migration.sql> <previous-count>',
  );
  process.exit(2);
}
const next = count + 1;
const escape = value => value.replaceAll('.', '\\.');
const rules = [
  // Only a literal maximum is a pin; `maximum: 6 * 60 * 60` is an unrelated expression.
  [new RegExp(`(minimum:\\s*[\\w.]+,\\s*maximum:\\s*)${count}\\b(?!\\s*[-+*/.])`, 'g'), `$1${next}`],
  [new RegExp(`("minimum":\\s*\\d+,\\s*"maximum":\\s*)${count}\\b`, 'g'), `$1${next}`],
  [new RegExp(`(\\b(?:migrations|stream|baseline|tf_common_migrations)\\.length,\\s*)${count}\\)`, 'g'), `$1${next})`],
  [new RegExp(`(\\.at\\(-1\\)\\.name,\\s*)(['"])${escape(previous)}\\2`, 'g'), `$1$2${added}$2`],
  // A pinned list of the stream's tail grows by one entry and its slice by one.
  [
    new RegExp(`(slice\\(-)(\\d+)(\\)[^\\n]*?)(['"])${escape(previous)}\\4(\\s*\\])`, 'g'),
    (_m, a, n, b, q, end) => `${a}${Number(n) + 1}${b}${q}${previous}${q}, ${q}${added}${q}${end}`,
  ],
  [
    new RegExp(`(['"])${escape(previous)}\\1(\\s*\\]\\s*,\\s*\\n?\\s*"Source common stream changed)`, 'g'),
    `$1${previous}$1, $1${added}$1$2`,
  ],
  [new RegExp(`(\\n\\s*)(['"])${escape(previous)}\\2,(\\n\\s*\\]\\)?;)`, 'g'), `$1$2${previous}$2,$1$2${added}$2,$3`],
  [new RegExp(`(['"])${escape(previous)}\\1(\\]\\);\\n)`, 'g'), `$1${previous}$1, $1${added}$1$2`],
];
const changed = [];
for await (const path of glob(
  ['packages/**/*.{ts,mjs}', 'apps/**/*.{ts,mjs}', 'tooling/*.mjs', 'infra/**/*.{mjs,py}'],
  { exclude: name => name === 'node_modules' || name === 'dist' },
)) {
  if (path.endsWith('bump-common-compatibility.mjs')) continue;
  const source = await readFile(path, 'utf8');
  let updated = source;
  for (const [pattern, replacement] of rules) updated = updated.replace(pattern, replacement);
  if (updated !== source) {
    await writeFile(path, updated);
    changed.push(path);
  }
}
console.log(changed.join('\n'));
console.error(`${changed.length} files updated from ${count} to ${next}.`);
