// Reads or changes this repository's @tulipfarm/sprout pin: the exact npm version in every app and
// package manifest that depends on it.
// Usage: node .github/sprout-upgrade/pin.mjs current | set <version>
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const manifests = ['apps', 'packages']
  .flatMap(dir => readdirSync(new URL(`${dir}/`, root)).map(name => new URL(`${dir}/${name}/package.json`, root)))
  .filter(file => existsSync(file))
  .filter(file => JSON.parse(readFileSync(file, 'utf8')).dependencies?.['@tulipfarm/sprout']);

const pins = new Set(manifests.map(file => JSON.parse(readFileSync(file, 'utf8')).dependencies['@tulipfarm/sprout']));
const [current] = pins;
if (pins.size !== 1 || !/^\d+\.\d+\.\d+$/.test(current)) {
  throw new Error(`Expected one exact @tulipfarm/sprout version, found: ${[...pins].join(', ')}`);
}

const [command, version] = process.argv.slice(2);
if (command === 'current') {
  console.log(current);
} else if (command === 'set' && /^\d+\.\d+\.\d+$/.test(version ?? '')) {
  for (const file of manifests) {
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, text.replace(`"@tulipfarm/sprout": "${current}"`, `"@tulipfarm/sprout": "${version}"`));
  }
} else {
  console.error('usage: pin.mjs current | set <version>');
  process.exit(2);
}
