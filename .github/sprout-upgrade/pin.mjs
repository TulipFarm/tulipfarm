// Reads or changes this repository's @tulipfarm/sprout pin, a GitHub release tarball.
// Usage: node .github/sprout-upgrade/pin.mjs current | set <version>
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../../apps/web/package.json', import.meta.url);
const tarball = version =>
  `https://github.com/TulipFarm/sprout/releases/download/v${version}/tulipfarm-sprout-${version}.tgz`;

const text = readFileSync(file, 'utf8');
const pin = JSON.parse(text).dependencies['@tulipfarm/sprout'];
const current = /\/v(\d+\.\d+\.\d+)\/tulipfarm-sprout-/.exec(pin)?.[1];
if (!current) throw new Error(`Unexpected @tulipfarm/sprout pin: ${pin}`);

const [command, version] = process.argv.slice(2);
if (command === 'current') {
  console.log(current);
} else if (command === 'set' && /^\d+\.\d+\.\d+$/.test(version ?? '')) {
  writeFileSync(file, text.replace(pin, tarball(version)));
} else {
  console.error('usage: pin.mjs current | set <version>');
  process.exit(2);
}
