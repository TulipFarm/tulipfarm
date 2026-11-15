// Refreshes icon-keys/*.json from the latest @lobehub/icons and simple-icons releases.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../icon-keys/', import.meta.url);
const unpack = name => {
  const dir = mkdtempSync(join(tmpdir(), 'icon-keys-'));
  const file = execFileSync('npm', ['pack', name, '--silent'], { cwd: dir, encoding: 'utf8' }).trim();
  execFileSync('tar', ['xzf', file], { cwd: dir });
  return dir;
};
const write = (name, keys) =>
  writeFileSync(new URL(name, root), `${JSON.stringify([...new Set(keys)].sort(), null, 0)}\n`);

const lobehub = unpack('@lobehub/icons');
write(
  'lobehub.json',
  readdirSync(join(lobehub, 'package/es')).filter(entry => /^[A-Z][A-Za-z0-9]*$/.test(entry)),
);
rmSync(lobehub, { recursive: true });

const simple = unpack('simple-icons');
const icons = await import(join(simple, 'package/index.mjs'));
write(
  'simple-icons.json',
  Object.values(icons).flatMap(icon => (icon?.slug ? [icon.slug] : [])),
);
rmSync(simple, { recursive: true });
