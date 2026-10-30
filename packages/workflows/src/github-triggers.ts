import { z } from 'zod';
import { commonCompatibility, qualified, type createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import {
  githubTriggerEvents,
  idSchema,
  payloadSchema,
  type GitHubTrigger,
  type GitHubTriggerEvent,
} from './contracts.ts';

type Pool = { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };
type Runtime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
type Json = Record<string, unknown>;

export type GitHubSubscriptions = {
  replace(subscription: {
    workspaceId: string;
    workflowId: string;
    revision: string;
    generation: number;
    trigger: GitHubTrigger;
  }): Promise<void>;
  remove(workspaceId: string, workflowId: string, generation: number): Promise<void>;
};

const fanOutLimit = 100;
const pendingLimit = 1000;

/** Keeps app.github_workflow_subscriptions in step with workflow activation. A lower generation never overwrites a higher one. */
export function createGitHubSubscriptions(pool: Pool): GitHubSubscriptions {
  return {
    async replace({ workspaceId, workflowId, revision, generation, trigger }) {
      await pool.query(
        `INSERT INTO app.github_workflow_subscriptions (workspace_id,workflow_id,revision,generation,repository_id,event,actions)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (workspace_id,workflow_id) DO UPDATE SET revision=EXCLUDED.revision,generation=EXCLUDED.generation,
          repository_id=EXCLUDED.repository_id,event=EXCLUDED.event,actions=EXCLUDED.actions
        WHERE app.github_workflow_subscriptions.generation<=EXCLUDED.generation`,
        [workspaceId, workflowId, revision, generation, trigger.repositoryId, trigger.event, trigger.actions ?? null],
      );
    },
    async remove(workspaceId, workflowId, generation) {
      await pool.query(
        'DELETE FROM app.github_workflow_subscriptions WHERE workspace_id=$1 AND workflow_id=$2 AND generation<=$3',
        [workspaceId, workflowId, generation],
      );
    },
  };
}

const subscriptionSchema = z.object({
  workspace_id: idSchema,
  workflow_id: idSchema,
  revision: idSchema,
  generation: z.number().int(),
});
const deliverySchema = z.looseObject({
  action: z.string().optional(),
  repository: z.looseObject({ id: z.number().int().positive() }),
});

/**
 * Queues one verified GitHub delivery for every workflow subscribed to its repository, event and action. Each workspace
 * gets the event in its own transaction, so one failing workspace does not stop the others; failures are thrown together
 * after every workspace was tried. A subscription whose workflow has since stopped is deleted.
 */
export function createGitHubWorkflowFanOut(pool: Pool, runtime: Runtime) {
  return async (delivery: { event: string; deliveryId: string; body: unknown }) => {
    if (!Object.hasOwn(githubTriggerEvents, delivery.event)) return;
    const event = delivery.event as GitHubTriggerEvent;
    const body = deliverySchema.safeParse(delivery.body);
    if (!body.success) return;
    const subscriptions = z.array(subscriptionSchema).parse(
      (
        await pool.query(
          `SELECT workspace_id,workflow_id,revision,generation FROM app.github_workflow_subscriptions
          WHERE repository_id=$1 AND event=$2 AND (actions IS NULL OR $3::text=ANY(actions))
          ORDER BY workspace_id,workflow_id LIMIT $4`,
          [String(body.data.repository.id), event, body.data.action ?? null, fanOutLimit],
        )
      ).rows,
    );
    if (!subscriptions.length) return;
    const payload = JSON.stringify(payloadSchema.parse(githubWorkflowPayload(event, body.data)));
    const failures: unknown[] = [];
    for (const subscription of subscriptions) {
      try {
        const stopped = await runtime.transaction(subscription.workspace_id, commonCompatibility, async tx => {
          const workflows = qualified(tx.schema, 'tf_workflows');
          const events = qualified(tx.schema, 'tf_provider_events');
          await tx.client.query(
            `INSERT INTO ${events} (workflow_id,revision,event_key,payload)
            SELECT w.id,w.active_revision,$3,$4 FROM ${workflows} w WHERE w.id=$1 AND w.enabled AND w.active_revision=$2
              AND (SELECT count(*) FROM ${events} e WHERE e.workflow_id=$1 AND e.revision=$2 AND NOT e.admitted)<$5
            ON CONFLICT DO NOTHING`,
            [subscription.workflow_id, subscription.revision, delivery.deliveryId, payload, pendingLimit],
          );
          // The subscription is written before its activation commits, so only a workflow state at least as new as the subscription proves it stale.
          const workflow = z
            .object({ live: z.boolean(), generation: z.number().int() })
            .optional()
            .parse(
              (
                await tx.client.query(
                  `SELECT (enabled AND active_revision=$2) AS live,generation FROM ${workflows} WHERE id=$1`,
                  [subscription.workflow_id, subscription.revision],
                )
              ).rows[0],
            );
          return !workflow || (!workflow.live && workflow.generation >= subscription.generation);
        });
        if (stopped)
          await pool.query(
            'DELETE FROM app.github_workflow_subscriptions WHERE workspace_id=$1 AND workflow_id=$2 AND generation=$3',
            [subscription.workspace_id, subscription.workflow_id, subscription.generation],
          );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'GitHub event did not reach every subscribed workflow');
  };
}

const object = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const number = (value: unknown) => (typeof value === 'number' ? value : null);
const flag = (value: unknown) => (typeof value === 'boolean' ? value : null);
function text(value: unknown, max = 512) {
  if (typeof value !== 'string') return null;
  const clean = value
    .replace(/\0/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�');
  return Array.from(clean).slice(0, max).join('');
}

/** The small part of a GitHub delivery a workflow run receives; long text is cut so the payload stays far below 32 KiB. */
export function githubWorkflowPayload(event: GitHubTriggerEvent, body: Json) {
  const base = {
    event,
    action: text(body.action, 64),
    repository: text(object(body.repository).full_name, 140),
    sender: text(object(body.sender).login, 64),
  };
  switch (event) {
    case 'star':
      return { ...base, starredAt: text(body.starred_at, 64) };
    case 'watch':
      return base;
    case 'issues': {
      const issue = object(body.issue);
      return {
        ...base,
        issue: {
          number: number(issue.number),
          title: text(issue.title),
          url: text(issue.html_url),
          state: text(issue.state, 32),
          body: text(issue.body, 4000),
        },
      };
    }
    case 'issue_comment': {
      const issue = object(body.issue);
      const comment = object(body.comment);
      return {
        ...base,
        issue: {
          number: number(issue.number),
          title: text(issue.title),
          url: text(issue.html_url),
          pullRequest: issue.pull_request !== undefined,
        },
        comment: { url: text(comment.html_url), body: text(comment.body, 4000) },
      };
    }
    case 'pull_request': {
      const pull = object(body.pull_request);
      return {
        ...base,
        pullRequest: {
          number: number(pull.number),
          title: text(pull.title),
          url: text(pull.html_url),
          state: text(pull.state, 32),
          draft: flag(pull.draft),
          merged: flag(pull.merged),
          body: text(pull.body, 4000),
          base: text(object(pull.base).ref, 256),
          head: text(object(pull.head).ref, 256),
        },
      };
    }
    case 'push': {
      const head = object(body.head_commit);
      return {
        ...base,
        ref: text(body.ref, 256),
        before: text(body.before, 64),
        after: text(body.after, 64),
        compare: text(body.compare),
        commits: Array.isArray(body.commits) ? body.commits.length : null,
        headCommit:
          body.head_commit === null || body.head_commit === undefined
            ? null
            : { id: text(head.id, 64), message: text(head.message, 4000), url: text(head.url) },
      };
    }
    case 'release': {
      const release = object(body.release);
      return {
        ...base,
        release: {
          tagName: text(release.tag_name, 256),
          name: text(release.name),
          url: text(release.html_url),
          prerelease: flag(release.prerelease),
          draft: flag(release.draft),
          body: text(release.body, 4000),
        },
      };
    }
  }
}
