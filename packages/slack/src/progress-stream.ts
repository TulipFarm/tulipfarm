import { z } from 'zod';
import { log } from '@tulipfarm/observability';
import { slackId } from './contracts.ts';
import { callSlackApi } from './web-api.ts';

const firstStep = 'tf_request';

export type SlackProgressStep = { id: string; title: string; status: 'in_progress' | 'complete' | 'error' };

const failed = (operation: string, error: unknown) =>
  log('warn', 'dependency', 'call_failed', {
    operation,
    'error.type': error instanceof Error ? error.message : 'unknown',
  });

/**
 * A streamed Slack message that shows a reply's tool steps as a plan while the reply runs. Every call is best effort:
 * a stream Slack refuses leaves the reply to arrive without progress. `finish` deletes the progress message, since the
 * checked answer is posted as its own message.
 */
export async function startSlackProgress(input: {
  token: string;
  channel: string;
  threadTs: string;
  recipient?: { user: string; team: string } | undefined;
  title: string;
  fetcher?: typeof fetch;
}) {
  const fetcher = input.fetcher ?? fetch;
  const channel = slackId.parse(input.channel);
  let ts: string;
  try {
    ts = z.object({ ts: z.string().regex(/^\d{1,16}\.\d{6}$/) }).parse(
      await callSlackApi({
        token: input.token,
        method: 'chat.startStream',
        params: {
          channel,
          thread_ts: input.threadTs,
          task_display_mode: 'plan',
          // The plan opens with a running step, so Slack shows it at once rather than a blank "Thinking" message.
          chunks: JSON.stringify([
            { type: 'plan_update', title: input.title },
            { type: 'task_update', id: firstStep, title: 'Reading your request', status: 'in_progress' },
          ]),
          ...(input.recipient
            ? { recipient_user_id: input.recipient.user, recipient_team_id: input.recipient.team }
            : {}),
        },
        fetcher,
        effect: true,
      }),
    ).ts;
  } catch (error) {
    failed('slack.progress.start', error);
    return undefined;
  }
  let open = true;
  let read = false;
  let queue = Promise.resolve();
  const append = (chunks: unknown[]) => {
    queue = queue.then(async () => {
      if (!open) return;
      try {
        await callSlackApi({
          token: input.token,
          method: 'chat.appendStream',
          params: { channel, ts, chunks: JSON.stringify(chunks) },
          fetcher,
        });
      } catch (error) {
        open = false;
        failed('slack.progress.append', error);
      }
    });
    return queue;
  };
  return {
    ts,
    step(step: SlackProgressStep) {
      const chunks: unknown[] = read
        ? []
        : [{ type: 'task_update', id: firstStep, title: 'Reading your request', status: 'complete' }];
      read = true;
      return append([
        ...chunks,
        { type: 'task_update', id: step.id, title: step.title.slice(0, 256), status: step.status },
      ]);
    },
    async finish() {
      await queue;
      open = false;
      for (const [method, params] of [
        ['chat.stopStream', { channel, ts }],
        ['chat.delete', { channel, ts }],
      ] as const)
        try {
          await callSlackApi({ token: input.token, method, params, fetcher, completed: ['message_not_found'] });
        } catch (error) {
          failed(`slack.progress.${method === 'chat.delete' ? 'delete' : 'stop'}`, error);
        }
    },
  };
}
export type SlackProgress = NonNullable<Awaited<ReturnType<typeof startSlackProgress>>>;
