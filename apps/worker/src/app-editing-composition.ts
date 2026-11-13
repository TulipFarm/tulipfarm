import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppEditing, type AppEditing, type AppTurnOutcome } from '@tulipfarm/agents/app-tools';
import { readAppRecipe, type AppBuildId, type AppFailure } from '@tulipfarm/apps';
import {
  appRepositories,
  finishBuild,
  readSourceBundles,
  requestBuild,
  type AppTransaction,
} from '@tulipfarm/apps/store';
import type { ConversationRuntime } from '@tulipfarm/conversations/runtime';
import { turnRequester } from '@tulipfarm/conversations/turn-requester';
import { errorAttributes, isFeatureEnabled, log } from '@tulipfarm/observability';
import { objectStorageClient } from '@tulipfarm/workspaces/object-storage';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';

type AppRepositories = ReturnType<typeof appRepositories>;
/** Starts building a queued build. Without it the build stays queued until something else builds it. */
export type AppBuildStart = (workspaceId: string, buildId: AppBuildId) => Promise<unknown>;

const copyBuilder = 'copy@1';

/** The app tools of an app's own chat, on when the workspace has the `app-hosting` flag. */
export function workerAppEditing(
  runtime: ConversationRuntime,
  repositories: AppRepositories,
  start?: AppBuildStart,
): AppEditing {
  const transact = <T>(workspaceId: string, action: (tx: AppTransaction) => Promise<T>) =>
    runtime.transaction(workspaceId, commonCompatibility, tx => action({ client: tx.client, schema: tx.schema }));
  return createAppEditing(runtime, {
    repositories,
    enabled: workspaceId => isFeatureEnabled('app-hosting', null, { id: workspaceId }),
    async requestBuild({ workspaceId, appId, commit, requestedBy }) {
      const repository = await repositories.open(
        workspaceId,
        appId,
        commit,
        await transact(workspaceId, tx => readSourceBundles(tx, appId)),
      );
      const appJson = await repositories.file(repository, commit, 'app.json');
      const read = readAppRecipe(appJson && new TextDecoder().decode(appJson));
      // The recipe follows from the commit, so a commit that cannot build records one failed build the editor can see.
      const refused: AppFailure | null = !read.ok
        ? read.failure
        : read.recipe.kind === 'command'
          ? { code: 'builder-unavailable', message: 'This server cannot run build commands', retryable: false }
          : null;
      const build = await transact(workspaceId, async tx => {
        const queued = await requestBuild(tx, {
          appId,
          commit,
          recipe: read.ok ? read.recipe : { kind: 'copy', root: '.' },
          builder: copyBuilder,
          requestedBy,
        });
        return refused ? finishBuild(tx, queued.id, { ok: false, failure: refused }) : queued;
      });
      if (build.status.status === 'queued') await start?.(workspaceId, build.id);
      return build.id;
    },
  });
}

/** App editing for a worker whose apps bucket is configured. */
export function appEditingFromEnvironment(runtime: ConversationRuntime, env: NodeJS.ProcessEnv = process.env) {
  const bucket = env.TULIPFARM_OBJECT_STORAGE_APPS_BUCKET;
  if (!bucket) return undefined;
  // A cache of its own: app builds keep theirs, so the two never write one repository at once.
  const root = join(tmpdir(), 'tulipfarm-app-drafts');
  return workerAppEditing(runtime, appRepositories({ root, storage: { client: objectStorageClient(env), bucket } }));
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
 * Saves or drops what a turn staged in its app chat once the turn has settled. Never throws: the turn already settled,
 * and an edit left behind lapses with its lease.
 */
export async function finishAppTurn(
  runtime: ConversationRuntime,
  apps: AppEditing,
  work: { readonly workspaceId: string; readonly conversationId: string; readonly turnId: string },
) {
  try {
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
    const finished = await apps.finishTurn(
      { workspaceId: work.workspaceId, actor: settled.actor, conversationId: work.conversationId },
      settled.outcome,
    );
    if ('error' in finished)
      log('warn', 'activity', 'call_failed', { operation: 'app.finish-turn', 'error.code': finished.error });
  } catch (error) {
    log('warn', 'activity', 'call_failed', { ...errorAttributes(error), operation: 'app.finish-turn' });
  }
}
