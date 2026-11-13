import { ActivityFailure, proxyActivities } from '@temporalio/workflow';
import type { AppActivities } from './app-activities.ts';

type AppInput = { readonly workspaceId: string };

const { buildApp } = proxyActivities<AppActivities>({
  startToCloseTimeout: '15 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 3, initialInterval: '5 seconds' },
});

const { stageAppRelease } = proxyActivities<AppActivities>({
  startToCloseTimeout: '10 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 5, initialInterval: '5 seconds' },
});

const { failAppOperation, switchAppRelease, projectAppEdge } = proxyActivities<AppActivities>({
  startToCloseTimeout: '1 minute',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 10, initialInterval: '2 seconds' },
});

/** Started as `app-build-<buildId>`. */
export async function appBuild(input: AppInput & { readonly buildId: string }) {
  return (await buildApp(input)).status;
}

async function release(input: AppInput & { readonly operationId: string }) {
  let staged: boolean;
  try {
    staged = await stageAppRelease(input);
  } catch (error) {
    if (!(error instanceof ActivityFailure)) throw error;
    await failAppOperation({ ...input, message: 'The files could not be copied to the app site. Try again.' });
    return 'failed';
  }
  if (!staged) return 'ended';
  const switched = await switchAppRelease(input);
  if (switched.switched) await projectAppEdge({ workspaceId: input.workspaceId, appId: switched.appId });
  return switched.status;
}

/** Started as `app-publish-<appId>-<operationId>`. */
export async function appPublish(input: AppInput & { readonly operationId: string }) {
  return release(input);
}

/** Started as `app-rollback-<appId>-<operationId>`. */
export async function appRollback(input: AppInput & { readonly operationId: string }) {
  return release(input);
}

/** Started as `app-edge-<appId>-<edgeVersion>` after a stop, resume or rename. */
export async function appProjectEdge(input: AppInput & { readonly appId: string }) {
  await projectAppEdge(input);
}
