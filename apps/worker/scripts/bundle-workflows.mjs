// Prebundles every workflow entry from the compiled worker, so workers skip webpack at startup.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { bundleWorkflowCode } from '@temporalio/worker';
import { temporalWorkflowInterceptorModule } from '../dist/temporal-tracing.js';
import { workflowBundleName, workflowEntries } from '../dist/workflow-source.js';

const dist = new URL('../dist/', import.meta.url);
for (const entry of workflowEntries) {
  for (const traced of [false, true]) {
    const { code } = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL(`${entry}.js`, dist)),
      workflowInterceptorModules: traced ? [temporalWorkflowInterceptorModule] : [],
    });
    await writeFile(new URL(workflowBundleName(entry, traced), dist), code);
  }
}
