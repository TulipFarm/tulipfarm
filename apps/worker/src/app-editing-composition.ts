import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Connection } from '@temporalio/client';
import { createAppPages, type AppPages } from '@tulipfarm/agents/app-page-tools';
import { createAppEditing, type AppEditing, type AppTurnOutcome } from '@tulipfarm/agents/app-tools';
import { appBuildWorkflowId, readAppRecipe, recipeBuilder, type AppBuildId, type AppFailure } from '@tulipfarm/apps';
import {
  appRepositories,
  finishBuild,
  readSourceBundles,
  requestBuild,
  type AppTransaction,
} from '@tulipfarm/apps/store';
import { temporalConnectionOptions } from '@tulipfarm/config/temporal';
import type { ConversationRuntime } from '@tulipfarm/conversations/runtime';
import { turnRequester } from '@tulipfarm/conversations/turn-requester';
import { errorAttributes, isFeatureEnabled, log } from '@tulipfarm/observability';
import { objectStorageClient } from '@tulipfarm/workspaces/object-storage';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';

type AppRepositories = ReturnType<typeof appRepositories>;

const appHosting = (workspaceId: string) => isFeatureEnabled('app-hosting', null, { id: workspaceId });

/** How this worker builds apps: starting a queued build, and the builder that runs build commands, if it has one. */
export type AppBuilds = {
  readonly start: (workspaceId: string, buildId: AppBuildId) => Promise<unknown>;
  readonly commandBuilder: () => string | undefined;
};

/** Starts the `appBuild` workflow, the same one the API starts for the same build. */
export function createAppBuildDispatcher() {
  const connection = Connection.lazy(temporalConnectionOptions());
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm';
  const start: AppBuilds['start'] = (workspaceId, buildId) =>
    connection.withDeadline(Date.now() + 5000, () =>
      client.workflow.start('appBuild', {
        workflowId: appBuildWorkflowId(buildId),
        taskQueue,
        args: [{ workspaceId, buildId }],
        workflowIdConflictPolicy: 'USE_EXISTING',
      }),
    );
  return { start, close: () => connection.close() };
}

/** The app tools of an app's own chat, on when the workspace has the `app-hosting` flag. */
export function workerAppEditing(
  runtime: ConversationRuntime,
  repositories: AppRepositories,
  builds: AppBuilds,
): AppEditing {
  const transact = <T>(workspaceId: string, action: (tx: AppTransaction) => Promise<T>) =>
    runtime.transaction(workspaceId, commonCompatibility, tx => action({ client: tx.client, schema: tx.schema }));
  return createAppEditing(runtime, {
    repositories,
    enabled: appHosting,
    async requestBuild({ workspaceId, appId, commit, requestedBy }) {
      const repository = await repositories.open(
        workspaceId,
        appId,
        commit,
        await transact(workspaceId, tx => readSourceBundles(tx, appId)),
      );
      const appJson = await repositories.file(repository, commit, 'app.json');
      const read = readAppRecipe(appJson && new TextDecoder().decode(appJson));
      const chosen = read.ok ? recipeBuilder(read.recipe, builds.commandBuilder()) : read;
      // The recipe follows from the commit, so a commit that cannot build records one failed build the editor can see.
      const refused: AppFailure | null = chosen.ok ? null : chosen.failure;
      const build = await transact(workspaceId, async tx => {
        const queued = await requestBuild(tx, {
          appId,
          commit,
          recipe: read.ok ? read.recipe : { kind: 'copy', root: '.' },
          builder: chosen.ok ? chosen.builder : 'none',
          requestedBy,
        });
        return refused ? finishBuild(tx, queued.id, { ok: false, failure: refused }) : queued;
      });
      if (build.status.status === 'queued' || build.status.status === 'running')
        await builds.start(workspaceId, build.id);
      return build.id;
    },
  });
}

/** The page tools of a private app's own chat, on when the workspace has the `app-hosting` flag. */
export function workerAppPages(runtime: ConversationRuntime): AppPages {
  return createAppPages(runtime, { enabled: appHosting });
}

/** App editing for a worker whose apps bucket is configured. */
export function appEditingFromEnvironment(
  runtime: ConversationRuntime,
  builds: AppBuilds,
  env: NodeJS.ProcessEnv = process.env,
) {
  const bucket = env.TULIPFARM_OBJECT_STORAGE_APPS_BUCKET;
  if (!bucket) return undefined;
  // A cache of its own: app builds keep theirs, so the two never write one repository at once.
  const root = join(tmpdir(), 'tulipfarm-app-drafts');
  return workerAppEditing(
    runtime,
    appRepositories({ root, storage: { client: objectStorageClient(env), bucket } }),
    builds,
  );
}

/**
 * How a settled turn ends its chat's edit. A paused turn saves too, since its pause can outlast the lease. A turn that
 * will be retried keeps its staged changes, since the retry resumes from the tool calls it already ran.
 */
const turnEndings: Partial<Record<string, AppTurnOutcome>> = {
  completed: 'completed',
  waiting: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  blocked: 'cancelled',
};

/**
 * Saves or drops what a turn staged in its app chat and frees the chat's hold on the draft once the turn has settled.
 * Never throws: the turn already settled, and an edit left behind lapses with its lease.
 */
export async function finishAppTurn(
  runtime: ConversationRuntime,
  editing: { readonly apps?: AppEditing | undefined; readonly pages?: AppPages | undefined },
  work: { readonly workspaceId: string; readonly conversationId: string; readonly turnId: string },
) {
  try {
    // Page tools are only offered with app hosting on, so without it a turn holds no page lease to free.
    const pages = editing.pages && (await appHosting(work.workspaceId)) ? editing.pages : undefined;
    if (!editing.apps && !pages) return;
    const settled = await runtime.transaction(work.workspaceId, commonCompatibility, async tx => {
      const [turn] = (
        await tx.client.query(
          `SELECT t.status FROM ${qualified(tx.schema, 'tf_conversation_turns')} t
           JOIN ${qualified(tx.schema, 'tf_conversations')} c ON c.id = t.conversation_id
           WHERE t.id = $1 AND t.conversation_id = $2 AND c.app_id IS NOT NULL`,
          [work.turnId, work.conversationId],
        )
      ).rows as { status: string }[];
      const outcome = turn && turnEndings[turn.status];
      return outcome ? { outcome, actor: await turnRequester(tx, work.conversationId, work.turnId) } : null;
    });
    if (!settled) return;
    const chat = { workspaceId: work.workspaceId, actor: settled.actor, conversationId: work.conversationId };
    const finished = await editing.apps?.finishTurn(chat, settled.outcome);
    if (finished && 'error' in finished)
      log('warn', 'activity', 'call_failed', { operation: 'app.finish-turn', 'error.code': finished.error });
    await pages?.finishTurn(chat);
  } catch (error) {
    log('warn', 'activity', 'call_failed', { ...errorAttributes(error), operation: 'app.finish-turn' });
  }
}
