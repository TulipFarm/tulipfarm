import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerOptions } from '@temporalio/worker';
import { temporalWorkflowInterceptorModule } from './temporal-tracing.ts';

/** Workflow modules that run in a Temporal worker; the build prebundles each one next to its compiled module. */
export const workflowEntries = [
  'workflows',
  'recommendation-workflows',
  'knowledge-all-workflows',
  'storage-workflows',
] as const;

export type WorkflowEntry = (typeof workflowEntries)[number];

/** File name of a prebuilt bundle, with or without the workflow tracing interceptor. */
export function workflowBundleName(entry: WorkflowEntry, traced: boolean) {
  return `${entry}${traced ? '.traced' : ''}.bundle.js`;
}

function bundleVariant(modules: readonly string[]) {
  if (!modules.length) return false;
  if (modules.length === 1 && modules[0] === temporalWorkflowInterceptorModule) return true;
  return undefined;
}

/**
 * Workflow code and interceptor options for `Worker.create`. A compiled worker loads the bundle the build wrote,
 * so it skips webpack at startup; that bundle already contains the workflow interceptors `options` asks for.
 * Running from source, without a bundle, or with other workflow interceptors, the worker bundles `entry` itself.
 */
export function workflowSource<T extends Pick<WorkerOptions, 'interceptors'>>(
  entry: WorkflowEntry,
  options: T,
): T & Pick<WorkerOptions, 'workflowBundle' | 'workflowsPath'> {
  const extension = extname(import.meta.filename);
  const { workflowModules = [], ...interceptors } = options.interceptors ?? {};
  const traced = bundleVariant(workflowModules);
  if (extension === '.js' && traced !== undefined) {
    const codePath = fileURLToPath(new URL(`./${workflowBundleName(entry, traced)}`, import.meta.url));
    if (existsSync(codePath)) return { ...options, interceptors, workflowBundle: { codePath } };
  }
  return { ...options, workflowsPath: fileURLToPath(new URL(`./${entry}${extension}`, import.meta.url)) };
}
