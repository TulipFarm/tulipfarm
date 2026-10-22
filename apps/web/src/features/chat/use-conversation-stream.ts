import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useFeatureContext } from '@/lib/query/provider';
import type { ConversationApi } from './conversation-api';
import { createConversationStream } from './conversation-stream';
import { conversationKeys } from './queries';

/** Streams reply previews and change hints for one saved chat and its plans while the page is visible. */
export function useConversationStream(api: ConversationApi, chatId: string, enabled: boolean) {
  const { runtime, scope } = useFeatureContext();
  const stream = useMemo(
    () =>
      createConversationStream(api.eventsUrl(chatId), change => {
        void runtime.applyChange(scope, {
          keys: [
            ...(change.history ? [conversationKeys.histories(chatId)] : []),
            ...(change.plans ? [conversationKeys.plans(chatId)] : []),
          ],
        });
      }),
    [api, chatId, runtime, scope],
  );
  useEffect(() => {
    if (!enabled) return;
    const sync = () => {
      if (document.visibilityState === 'hidden') stream.stop();
      else stream.start();
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      stream.stop();
    };
  }, [stream, enabled]);
  const snapshot = useSyncExternalStore(stream.subscribe, stream.snapshot, stream.snapshot);
  return { ...snapshot, status: enabled ? snapshot.status : ('unavailable' as const), retry: stream.retry };
}
