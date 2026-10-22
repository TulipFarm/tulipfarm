// Runs startExtensions('api') the way the apps do, for the startup-failure test.
import { startExtensions } from '../../src/loader.ts';
import { loadedExtensions } from '../../src/index.ts';

await startExtensions('api');
process.stdout.write(`loaded=${JSON.stringify(loadedExtensions())}\n`);
