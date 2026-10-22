import { setLogLevel } from '@azure/logger';
import { parseStorageReleaseArgs, storageReleaseHelp, StorageReleaseError } from './storage-release.ts';

async function main() {
  const command = parseStorageReleaseArgs(process.argv.slice(2));
  if (command === 'help') {
    process.stdout.write(storageReleaseHelp);
    return;
  }
  setLogLevel('error');
  const { executeProductionStorageRelease } = await import('./storage-release-production.ts');
  const result = await executeProductionStorageRelease(command);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch(error => {
  process.stderr.write(
    `${error instanceof StorageReleaseError ? error.message : 'Storage release failed. Inspect prerequisites and scoped configuration; secret details suppressed.'}\n`,
  );
  process.exitCode = 1;
});
