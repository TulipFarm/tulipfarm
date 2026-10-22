import { recommendationNotificationSchema } from '@tulipfarm/recommendations/contracts';
import { browserStreamEnvironment, type ConversationStreamEnvironment } from './conversation-stream.ts';

export function createRecommendationStream(
  url: string,
  identity: { workspaceId: string; membershipId: string },
  changed: (kind: 'change' | 'conceal') => void,
  environment: ConversationStreamEnvironment = browserStreamEnvironment,
) {
  let status: 'connecting' | 'open' | 'unavailable' = 'connecting';
  let source: ReturnType<ConversationStreamEnvironment['connect']> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let version = 0;
  const listeners = new Set<() => void>();
  const publish = (next: typeof status) => {
    status = next;
    for (const listener of listeners) listener();
  };
  function close() {
    environment.clearTimeout(timer);
    timer = undefined;
    source?.close();
    source = undefined;
  }
  function connect() {
    close();
    changed('conceal');
    publish('connecting');
    const current = environment.connect(url);
    source = current;
    current.addEventListener('open', () => {
      if (source !== current) return;
      failures = 0;
      changed('conceal');
      publish('open');
    });
    current.addEventListener('error', () => {
      if (source !== current) return;
      close();
      changed('conceal');
      publish(++failures >= 3 ? 'unavailable' : 'connecting');
      if (failures < 3) timer = environment.setTimeout(connect, 2000);
    });
    current.addEventListener('resync', () => {
      if (source === current) changed('conceal');
    });
    for (const kind of ['changed', 'invalidated'])
      current.addEventListener(kind, event => {
        if (source !== current) return;
        let data: unknown;
        try {
          data = JSON.parse(event.data);
        } catch {
          changed('conceal');
          return;
        }
        const parsed = recommendationNotificationSchema.safeParse(data);
        if (!parsed.success) {
          changed('conceal');
          return;
        }
        if (
          parsed.data.workspaceId !== identity.workspaceId ||
          parsed.data.membershipId !== identity.membershipId ||
          parsed.data.version < version
        )
          return;
        version = parsed.data.version;
        changed(parsed.data.kind === 'invalidated' ? 'conceal' : 'change');
      });
  }
  return {
    snapshot: () => status,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (!source && timer === undefined) {
        failures = 0;
        connect();
      }
    },
    retry() {
      if (status === 'unavailable') {
        failures = 0;
        connect();
      }
    },
    stop() {
      close();
      publish('connecting');
    },
  };
}
