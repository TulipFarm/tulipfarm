import { useEffect, useMemo, useRef } from 'react';
import { GlobeIcon } from '@tulipfarm/icons';
import { Button } from '@tulipfarm/sprout/button';
import { useCanvas } from '@/features/chat/canvas-state';
import type { ConversationMessage } from '@/features/chat/conversation-api';
import { outcomeSaved } from '@/features/chat/live-tools';
import { browserApi } from './api';
import { isBrowserTool, liveBrowserCanvasId } from './live-browser';

type Tool = { tool: string; status: string; browserNotOpened?: true | undefined };

const checkEveryMs = 1_500;

function useShowBrowser(workspaceId: string, chatId: string) {
  const canvas = useCanvas();
  return () =>
    canvas.show({
      id: liveBrowserCanvasId(chatId),
      title: 'Browser',
      content: { kind: 'live-browser', workspaceId, chatId },
    });
}

/**
 * Opens the live browser once per chat: when the agent asks for a person, or once a browser is open while the agent
 * uses it. A browser call refused before any browser opened, such as one waiting for a free browser, opens nothing.
 */
export function useLiveBrowserOpening(workspaceId: string, chatId: string, tools: readonly Tool[], enabled: boolean) {
  const show = useShowBrowser(workspaceId, chatId);
  const api = useMemo(() => browserApi(workspaceId, { kind: 'chat', chatId }), [workspaceId, chatId]);
  const opened = useRef<string | null>(null);
  const wasActive = useRef(false);
  const active = enabled && tools.some(tool => isBrowserTool(tool.tool) && tool.status === 'running');
  const handoff = enabled && tools.some(tool => tool.tool === 'browser.handoff' && !tool.browserNotOpened);
  useEffect(() => {
    if (opened.current === chatId) return;
    if (handoff) {
      opened.current = chatId;
      show();
      return;
    }
    // A step that ended between checks may still have opened the browser, so look once more when it ends.
    const finalCheck = !active && wasActive.current;
    wasActive.current = active;
    if (!active && !finalCheck) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () =>
      api.state(controller.signal).then(
        state => {
          if (controller.signal.aborted || opened.current === chatId) return;
          if (state) {
            opened.current = chatId;
            show();
          } else if (active) timer = setTimeout(check, checkEveryMs);
        },
        () => {
          if (!controller.signal.aborted && active) timer = setTimeout(check, checkEveryMs);
        },
      );
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // `show` changes with every render; opening depends only on the chat and its activity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, handoff, chatId, api]);
}

/** Whether a reply used a browser it can show: not one refused before any browser opened. */
export function usedBrowser(tools: ConversationMessage['tools']) {
  return tools.some(tool => isBrowserTool(tool.tool) && outcomeSaved(tool) && !tool.browserNotOpened);
}

/** Under a reply that used the browser, reopens the live view. */
export function BrowserActivityCard({ workspaceId, chatId }: { workspaceId: string; chatId: string }) {
  const show = useShowBrowser(workspaceId, chatId);
  return (
    <Button variant="outline" size="sm" onClick={show}>
      <GlobeIcon size="sm" aria-hidden="true" />
      Show the browser
    </Button>
  );
}
