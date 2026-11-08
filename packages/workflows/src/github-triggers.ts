import { z } from 'zod';
import { qualified, type createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workflowCompatibility } from './authorization.ts';
import {
  githubTriggerEvents,
  idSchema,
  payloadSchema,
  type GitHubTrigger,
  type GitHubTriggerEvent,
} from './contracts.ts';

type Client = { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };
type Pool = Client & { connect(): Promise<Client & { release(): void }> };
type Runtime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
type Json = Record<string, unknown>;

export type GitHubSubscriptions = {
  /** Replaces the subscriptions of a workflow with one for each GitHub trigger of the activated revision. */
  replace(subscription: {
    workspaceId: string;
    workflowId: string;
    revision: string;
    generation: number;
    triggers: readonly (GitHubTrigger & { id: string })[];
  }): Promise<void>;
  remove(workspaceId: string, workflowId: string, generation: number): Promise<void>;
};

const fanOutLimit = 100;
const pendingLimit = 1000;

/** Keeps app.github_workflow_subscriptions in step with workflow activation. A lower generation never overwrites a higher one. */
export function createGitHubSubscriptions(pool: Pool): GitHubSubscriptions {
  return {
    async replace({ workspaceId, workflowId, revision, generation, triggers }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `github-workflow-subscriptions:${workspaceId}:${workflowId}`,
        ]);
        const newer = await client.query(
          'SELECT 1 FROM app.github_workflow_subscriptions WHERE workspace_id=$1 AND workflow_id=$2 AND generation>$3 LIMIT 1',
          [workspaceId, workflowId, generation],
        );
        if (newer.rows.length) {
          await client.query('ROLLBACK');
          return;
        }
        await client.query('DELETE FROM app.github_workflow_subscriptions WHERE workspace_id=$1 AND workflow_id=$2', [
          workspaceId,
          workflowId,
        ]);
        for (const trigger of triggers) {
          const account = Array.isArray(trigger.repositories) ? null : trigger.repositories.organizationId;
          await client.query(
            `INSERT INTO app.github_workflow_subscriptions (workspace_id,workflow_id,trigger_id,revision,generation,organization_id,include_future,events)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              workspaceId,
              workflowId,
              trigger.id,
              revision,
              generation,
              account,
              account !== null,
              JSON.stringify(trigger.events),
            ],
          );
          if (Array.isArray(trigger.repositories))
            await client.query(
              `INSERT INTO app.github_workflow_subscription_repositories (workspace_id,workflow_id,trigger_id,repository_id)
              SELECT $1,$2,$3,unnest($4::text[])`,
              [workspaceId, workflowId, trigger.id, trigger.repositories],
            );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
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
  repository: z.looseObject({
    id: z.number().int().positive(),
    owner: z.looseObject({ id: z.number().int().positive() }).optional(),
  }),
});
/** Whether a trigger stored in a revision matches a delivery's repository, owner account, event and action. */
const triggerMatches = (trigger: string, repository: string, owner: string, event: string, action: string) =>
  `${trigger}->>'kind'='github'
  AND (CASE WHEN jsonb_typeof(${trigger}->'repositories')='array' THEN ${trigger}->'repositories' ? ${repository}
    ELSE ${trigger}->'repositories'->>'organizationId'=${owner} END)
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(${trigger}->'events') e
    WHERE e->>'event'=${event} AND (NOT e ? 'actions' OR e->'actions' ? ${action}))`;

/**
 * Queues one verified GitHub delivery for every workflow with a GitHub trigger on its repository, or on the account that
 * owns it, and on its event and action. Each workspace gets the event in its own transaction, so one failing workspace
 * does not stop the others; failures are thrown together after every workspace was tried. A subscription whose workflow
 * has since stopped is deleted.
 */
export function createGitHubWorkflowFanOut(pool: Pool, runtime: Runtime) {
  return async (delivery: { event: string; deliveryId: string; body: unknown }) => {
    if (!Object.hasOwn(githubTriggerEvents, delivery.event)) return;
    const event = delivery.event as GitHubTriggerEvent;
    const body = deliverySchema.safeParse(delivery.body);
    if (!body.success) return;
    const repositoryId = String(body.data.repository.id),
      ownerId = body.data.repository.owner ? String(body.data.repository.owner.id) : '',
      action = body.data.action ?? '';
    const subscriptions = z.array(subscriptionSchema).parse(
      (
        await pool.query(
          `WITH matched AS (
            SELECT workspace_id,workflow_id,trigger_id FROM app.github_workflow_subscription_repositories WHERE repository_id=$1
            UNION SELECT workspace_id,workflow_id,trigger_id FROM app.github_workflow_subscriptions
              WHERE include_future AND organization_id=$2
          )
          SELECT DISTINCT s.workspace_id,s.workflow_id,s.revision,s.generation
          FROM matched m JOIN app.github_workflow_subscriptions s USING (workspace_id,workflow_id,trigger_id)
          WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(s.events) e
            WHERE e->>'event'=$3 AND (NOT e ? 'actions' OR e->'actions' ? $4::text))
          ORDER BY s.workspace_id,s.workflow_id LIMIT $5`,
          [repositoryId, ownerId, event, action, fanOutLimit],
        )
      ).rows,
    );
    if (!subscriptions.length) return;
    const payload = JSON.stringify(payloadSchema.parse(githubWorkflowPayload(event, body.data)));
    const failures: unknown[] = [];
    for (const subscription of subscriptions) {
      try {
        const stopped = await runtime.transaction(subscription.workspace_id, workflowCompatibility, async tx => {
          const workflows = qualified(tx.schema, 'tf_workflows');
          const revisions = qualified(tx.schema, 'tf_workflow_revisions');
          const triggers = qualified(tx.schema, 'tf_workflow_triggers');
          const events = qualified(tx.schema, 'tf_provider_events');
          const repositories = qualified(tx.schema, 'tf_knowledge_github_repositories');
          // A verified delivery names the repository's owner, so connected repositories stored without one learn it.
          if (ownerId)
            await tx.client.query(
              `UPDATE ${repositories} r SET owner_id=$2 FROM (
                SELECT source_id FROM ${repositories} WHERE repository_id=$1 AND owner_id IS NULL
                ORDER BY source_id FOR UPDATE SKIP LOCKED
              ) c WHERE r.source_id=c.source_id AND r.repository_id=$1`,
              [repositoryId, ownerId],
            );
          // One delivery queues one event per workflow, listing every switched-on GitHub trigger it matches in definition order.
          await tx.client.query(
            `INSERT INTO ${events} (workflow_id,revision,trigger_id,fired_trigger_ids,event_key,payload,github_repository_id)
            SELECT w.id,w.active_revision,m.ids[1],m.ids,$3,$4,$6 FROM ${workflows} w
            JOIN ${revisions} d ON d.workflow_id=w.id AND d.id=w.active_revision
            CROSS JOIN LATERAL (
              SELECT array_agg(t.value->>'id' ORDER BY t.ordinality) AS ids
              FROM jsonb_array_elements(d.definition->'triggers') WITH ORDINALITY t
              JOIN ${triggers} s ON s.workflow_id=w.id AND s.trigger_id=t.value->>'id' AND s.enabled
              WHERE ${triggerMatches('t.value', '$6', '$7', '$8', '$9::text')}
            ) m
            WHERE w.id=$1 AND w.enabled AND w.active_revision=$2 AND m.ids IS NOT NULL
              AND (SELECT count(*) FROM ${events} e WHERE e.workflow_id=$1 AND e.revision=$2 AND NOT e.admitted)<$5
            ON CONFLICT DO NOTHING`,
            [
              subscription.workflow_id,
              subscription.revision,
              delivery.deliveryId,
              payload,
              pendingLimit,
              repositoryId,
              ownerId,
              event,
              action,
            ],
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
    senderUrl: text(object(body.sender).html_url),
  };
  switch (event) {
    case 'star':
      return { ...base, starredAt: text(body.starred_at, 64), stars: number(object(body.repository).stargazers_count) };
    case 'watch':
      return { ...base, stars: number(object(body.repository).stargazers_count) };
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
