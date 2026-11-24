import { useEffect, useRef } from 'react';
import { GlobeIcon } from '@tulipfarm/icons';
import { Button } from '@tulipfarm/sprout/button';
import { useCanvas } from '@/features/chat/canvas-state';
import { isBrowserTool, liveBrowserCanvasId } from './live-browser';

type Tool = { tool: string; status: string };

function useShowBrowser(workspaceId: string, chatId: string) {
  const canvas = useCanvas();
  return () =>
    canvas.show({
      id: liveBrowserCanvasId(chatId),
      title: 'Browser',
      content: { kind: 'live-browser', workspaceId, chatId },
    });
}

/** Opens the live browser once per chat, when the agent starts using it or asks for a person. */
export function useLiveBrowserOpening(workspaceId: string, chatId: string, tools: readonly Tool[], enabled: boolean) {
  const show = useShowBrowser(workspaceId, chatId);
  const opened = useRef<string | null>(null);
  const active = enabled && tools.some(tool => isBrowserTool(tool.tool) && tool.status === 'running');
  const handoff = enabled && tools.some(tool => tool.tool === 'browser.handoff');
  useEffect(() => {
    if (!(active || handoff) || opened.current === chatId) return;
    opened.current = chatId;
    show();
    // `show` changes with every render; opening depends only on the chat and its activity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, handoff, chatId]);
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
