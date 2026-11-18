import { useEffect } from 'react';
import { usePrefetchRead } from '@/lib/query/prefetch';
import type { RecordSection } from './record-reads';

const record =
  /^\/([^/]+)\/(chat|projects|agents|agent-tasks|workflows|tables|files)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;
// Lists and the workspace navigation, where people browse records. Links inside chats and cards are left alone.
const browsing = '[data-slot="data-list"], [data-record-links]';
// A short pause skips links the pointer only passes over.
const hoverDelay = 100;

function recordLink(target: EventTarget | null, slug: string) {
  const link = target instanceof Element ? target.closest('a[href]') : null;
  if (!(link instanceof HTMLAnchorElement) || link.origin !== location.origin || !link.closest(browsing)) return null;
  const [, linkSlug, section, id] = record.exec(link.pathname) ?? [];
  if (!linkSlug || !section || !id || linkSlug !== encodeURIComponent(slug)) return null;
  return { link, section: section as RecordSection, id };
}

/**
 * Pointing at or focusing a list or navigation link to a chat, project, agent, task, workflow, table
 * or file in this workspace starts the read its page opens with, so the page can show it at once.
 */
export function useRecordLinkPrefetch(workspaceId: string, slug: string) {
  const prefetch = usePrefetchRead();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: HTMLAnchorElement | null = null;
    const start = (section: RecordSection, id: string) =>
      void import('./record-reads').then(({ recordRead }) => prefetch(recordRead(workspaceId, section, id)));
    const over = (event: PointerEvent) => {
      const found = recordLink(event.target, slug);
      if (!found || found.link === pending) return;
      clearTimeout(timer);
      pending = found.link;
      timer = setTimeout(() => {
        pending = null;
        start(found.section, found.id);
      }, hoverDelay);
    };
    const out = (event: PointerEvent) => {
      if (!pending || (event.relatedTarget instanceof Node && pending.contains(event.relatedTarget))) return;
      clearTimeout(timer);
      pending = null;
    };
    const focus = (event: FocusEvent) => {
      const found = recordLink(event.target, slug);
      if (found) start(found.section, found.id);
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    document.addEventListener('focusin', focus);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerout', out);
      document.removeEventListener('focusin', focus);
    };
  }, [workspaceId, slug, prefetch]);
}

export function RecordLinkPrefetch({ workspaceId, slug }: { workspaceId: string; slug: string }) {
  useRecordLinkPrefetch(workspaceId, slug);
  return null;
}
