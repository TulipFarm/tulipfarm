import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = process.argv.slice(2);
if (!files.length)
  files.push(
    'AGENTS.md',
    'README.md',
    'CONTRIBUTING.md',
    'DEVELOPMENT.md',
    'SECURITY.md',
    'CHANGELOG.md',
    'apps/web/README.md',
    'apps/web/DESIGN.md',
    'apps/web/src/lib/query/README.md',
    'apps/web/src/components/tulip-avatar/README.md',
    'packages/extensions/README.md',
  );
const failures = [];
let checked = 0;
for (const file of files) {
  const path = resolve(root, file);
  const text = await readFile(path, 'utf8');
  for (const match of text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    checked++;
    try {
      await access(resolve(dirname(path), decodeURIComponent(target)));
    } catch {
      failures.push(`${file}:${text.slice(0, match.index).split('\n').length}: ${target}`);
    }
  }
}
if (failures.length) {
  process.stderr.write(`Missing documentation targets:\n${failures.join('\n')}\n`);
  process.exitCode = 1;
} else
  process.stdout.write(`Checked ${checked} local documentation targets in ${files.length} entry-point documents.\n`);
