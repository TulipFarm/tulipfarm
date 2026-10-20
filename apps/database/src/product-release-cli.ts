import { setLogLevel } from '@azure/logger';
import { parseProductReleaseArgs, productReleaseHelp, ProductReleaseError } from './product-release.ts';

async function main() {
  const command = parseProductReleaseArgs(process.argv.slice(2));
  if (command === 'help') {
    process.stdout.write(productReleaseHelp);
    return;
  }
  setLogLevel('error');
  const { executeProductionProductRelease } = await import('./product-release-production.ts');
  process.stdout.write(`${JSON.stringify(await executeProductionProductRelease(command))}\n`);
}
main().catch(error => {
  process.stderr.write(
    `${error instanceof ProductReleaseError ? error.message : 'Product preparation failed. Secret details suppressed.'}\n`,
  );
  process.exitCode = 1;
});
