import { Client } from 'pg';
import { z } from 'zod';
import { conversationEventChannel, conversationNotificationSchema } from '@tulipfarm/conversations/events';
import { log } from '@tulipfarm/observability';

type Target = { workspaceId: string; conversationId: string; turnId: string; id: string };
type Listener = (key: string) => void;
export type SubagentStops = (target: Target, listener: Listener) => () => void;

const keyOf = (target: Target) => `${target.workspaceId}:${target.conversationId}:${target.turnId}:${target.id}`;

/**
 * Delivers per-card Stop requests to the worker that runs a reply's sub-agents. The API sends them as `subagent-stop`
 * notifications; one connection listens only while a delegation runs. Without a database URL, per-card Stop is
 * unavailable, and stopping the reply still stops every sub-agent.
 */
export function createSubagentStops(
  env: NodeJS.ProcessEnv = process.env,
  connect: (url: string) => Pick<Client, 'connect' | 'query' | 'on' | 'end'> = url =>
    new Client({ connectionString: url }),
): SubagentStops {
  const listeners = new Map<string, Set<Listener>>();
  let client: ReturnType<typeof connect> | undefined;
  const url = z.url().safeParse(env.WORKSPACE_AUTHORING_DATABASE_URL);

  function receive(payload: string | undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload ?? '');
    } catch {
      return;
    }
    const result = conversationNotificationSchema.safeParse(parsed);
    if (!result.success || result.data.kind !== 'subagent-stop') return;
    for (const listener of listeners.get(keyOf(result.data)) ?? []) listener(result.data.key);
  }
  function close() {
    const current = client;
    client = undefined;
    current?.end().catch(() => {});
  }
  function open() {
    if (!url.success || client) return;
    const current = connect(url.data);
    client = current;
    current.on('notification', message => {
      if (message.channel === conversationEventChannel) receive(message.payload);
    });
    current.on('error', () => {
      if (client === current) close();
    });
    void (async () => {
      await current.connect();
      await current.query(`LISTEN ${conversationEventChannel}`);
    })().catch(() => {
      log('warn', 'dependency', 'database_connection_failed', { operation: 'chat.subagent-stop' });
      if (client === current) close();
    });
  }
  return (target, listener) => {
    const key = keyOf(target);
    const group = listeners.get(key) ?? new Set();
    group.add(listener);
    listeners.set(key, group);
    open();
    return () => {
      group.delete(listener);
      if (!group.size) listeners.delete(key);
      if (!listeners.size) close();
    };
  };
}
