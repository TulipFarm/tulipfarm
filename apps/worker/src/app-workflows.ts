import { ActivityFailure, proxyActivities } from '@temporalio/workflow';
import type { AppActivities } from './app-activities.ts';
import type { AppServerActivities } from './app-server-activities.ts';

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

const { prepareAppServer, recordAppServerCandidate, failAppServerOperation, removeAppHost } =
  proxyActivities<AppServerActivities>({
    startToCloseTimeout: '1 minute',
    heartbeatTimeout: '30 seconds',
    retry: { maximumAttempts: 10, initialInterval: '2 seconds' },
  });

// Each call bounds the host's own retries below these timeouts, then fails the operation itself.
const { provisionAppServer } = proxyActivities<AppServerActivities>({
  startToCloseTimeout: '7 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 3, initialInterval: '5 seconds' },
});

const { switchAppServer } = proxyActivities<AppServerActivities>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 3, initialInterval: '5 seconds' },
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

async function retire(appId: string, hostRef: string | null) {
  if (hostRef !== null) await removeAppHost({ appId, hostRef });
}

/** Brings up the operation's host, records it, switches the endpoint to it, then the live release. */
async function serve(input: AppInput & { readonly operationId: string }) {
  const target = await prepareAppServer(input);
  if (!target) return 'ended';
  const giveUp = async (message: string) => {
    await retire(target.appId, (await failAppServerOperation({ ...input, message })).retiredHostRef);
    return 'failed';
  };
  let hostRef: string;
  try {
    const provisioned = await provisionAppServer({ ...input, ...target });
    if (!provisioned.ok) return 'failed';
    hostRef = provisioned.hostRef;
  } catch (error) {
    if (!(error instanceof ActivityFailure)) throw error;
    return giveUp('The app server could not start. Try again.');
  }
  const recorded = await recordAppServerCandidate({ ...input, hostRef });
  await retire(target.appId, recorded.retiredHostRef);
  if (recorded.status !== 'staging') return recorded.status;
  let switched: Awaited<ReturnType<typeof switchAppServer>>;
  try {
    switched = await switchAppServer({ ...input, hostRef });
  } catch (error) {
    if (!(error instanceof ActivityFailure)) throw error;
    return giveUp('The app could not be switched to its new server. Try again.');
  }
  await retire(target.appId, switched.retiredHostRef);
  if (switched.switched) await projectAppEdge({ workspaceId: input.workspaceId, appId: switched.appId });
  return switched.status;
}

/** Started as `app-publish-<appId>-<operationId>` for a release that runs a server. */
export async function appServerPublish(input: AppInput & { readonly operationId: string }) {
  return serve(input);
}

/** Started as `app-rollback-<appId>-<operationId>` for a release that runs a server. */
export async function appServerRollback(input: AppInput & { readonly operationId: string }) {
  return serve(input);
}

/** Started as `app-resize-<appId>-<operationId>`. Brings up the live release at the new size. */
export async function appServerResize(input: AppInput & { readonly operationId: string }) {
  return serve(input);
}
