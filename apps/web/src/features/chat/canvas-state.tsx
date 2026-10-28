import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useRouter } from '@tanstack/react-router';
import { KeepsEditsContext, type KeepsEdits } from '@/features/tables/feedback';
import { canvasSelection, emptyCanvas } from './canvas-selection';
import type { ChatPlanStep } from '@tulipfarm/sprout/chat-plan';
import type { UsageSeries } from '@tulipfarm/sprout/chart';
import type { ViewableFile } from '@/lib/file-viewer';
import type { RowView } from '@tulipfarm/conversations/row-view';
import type { CalendarHistoryResult } from '@tulipfarm/google-workspace/calendar-events';
import type { RecordChanges } from './record-changes';
import type { WorkflowReference } from '@/features/workflows/workflow-detail';
import type { GoogleMutation } from '@/features/google/action-state';
import type { ResultActivity } from './result-activity';
import type { FileReference } from './draft-files';
import { canvasSplitMinWidth } from '@tulipfarm/sprout/canvas';
import type { SystemPackage } from '@tulipfarm/agents/system-package-contracts';

export type CanvasContent =
  | { kind: 'package-plan'; document: SystemPackage; order?: string[] | undefined }
  | { kind: 'package-installation'; workspaceId: string; chatId: string; installationId: string }
  | { kind: 'activity-result'; items: ResultActivity[] }
  | { kind: 'github-batch'; workspaceId: string; chatId: string; batchId: string; task: boolean }
  | { kind: 'slack-action'; workspaceId: string; actionId: string }
  | { kind: 'workflow'; workspaceId: string; reference: WorkflowReference }
  | { kind: 'records'; reference: RowView }
  | { kind: 'record-changes'; change: RecordChanges }
  | { kind: 'calendar-read'; result: CalendarHistoryResult }
  | { kind: 'calendar-action'; workspaceId: string; proposalId: string }
  | { kind: 'google-action'; workspaceId: string; proposalId: string }
  | { kind: 'google-file'; workspaceId: string; fileId: string }
  | { kind: 'table'; columns: string[]; rows: (string | number)[][]; caption?: string }
  | { kind: 'chart'; category: string; series: UsageSeries[]; rows: Record<string, number | string>[] }
  | { kind: 'todo'; steps: ChatPlanStep[] }
  | { kind: 'plan'; workspaceId: string; chatId: string; planId: string }
  | { kind: 'schema'; workspaceId: string; chatId: string; proposalId: string }
  | { kind: 'code'; code: string; language: string; filename?: string }
  | { kind: 'browser'; url: string }
  | { kind: 'file'; file: ViewableFile }
  | { kind: 'workspace-file'; workspaceId: string; fileId: string; name: string; mediaType: string };

export type CanvasItem = {
  id: string;
  title: string;
  status?: 'loading' | 'error' | undefined;
  content: CanvasContent;
};

type Canvas = {
  actionMutations: Record<string, 'pending' | 'uncertain' | undefined>;
  setActionMutation: (id: string, state: 'pending' | 'uncertain' | undefined) => void;
  googleMutations: Readonly<Record<string, GoogleMutation>>;
  setGoogleMutation: (proposalId: string, mutation: GoogleMutation) => void;
  /** Text, and files to reference, for the chat composer to add to its draft. */
  composerRequest: { id: string; prompt: string; files: readonly FileReference[] } | null;
  requestComposer: (prompt: string, files?: readonly FileReference[]) => void;
  consumeComposer: (id: string) => void;
  attention: string | null;
  registerAttention: (id: string, label: string | null) => void;
  open: boolean;
  items: CanvasItem[];
  activeId: string | null;
  show: (item: CanvasItem) => void;
  update: (id: string, patch: Partial<Omit<CanvasItem, 'id'>>) => void;
  select: (id: string) => void;
  close: (id: string) => void;
  setOpen: (open: boolean) => void;
  toggle: () => void;
};

const CanvasContext = createContext<Canvas | null>(null);

declare module '@tanstack/react-router' {
  interface HistoryState {
    chatResultView?: string;
  }
}

const keepsConversation: KeepsEdits = (current, next) =>
  current.pathname === next.pathname && JSON.stringify(current.search) === JSON.stringify(next.search);

export function CanvasProvider({
  children,
  onOpenItem,
}: {
  children: ReactNode;
  onOpenItem?: (() => void) | undefined;
}) {
  const [actionMutations, setActionMutations] = useState<Canvas['actionMutations']>({});
  const setActionMutation = useCallback((id: string, state: 'pending' | 'uncertain' | undefined) => {
    setActionMutations(current => ({ ...current, [id]: state }));
  }, []);
  const [googleMutations, setGoogleMutations] = useState<Record<string, GoogleMutation>>({});
  const setGoogleMutation = useCallback((proposalId: string, mutation: GoogleMutation) => {
    setGoogleMutations(current => ({ ...current, [proposalId]: mutation }));
  }, []);
  const [composerRequest, setComposerRequest] = useState<Canvas['composerRequest']>(null);
  const requestComposer = useCallback(
    (prompt: string, files: readonly FileReference[] = []) =>
      setComposerRequest({ id: crypto.randomUUID(), prompt, files }),
    [],
  );
  const consumeComposer = useCallback(
    (id: string) => setComposerRequest(current => (current?.id === id ? null : current)),
    [],
  );
  const [{ open, items, activeId }, dispatch] = useReducer(canvasSelection, emptyCanvas);
  const [announcement, setAnnouncement] = useState('');
  const [attention, setAttention] = useState(new Map<string, string>());
  const registerAttention = useCallback((id: string, label: string | null) => {
    setAttention(current => {
      if ((current.get(id) ?? null) === label) return current;
      const next = new Map(current);
      if (label) next.set(id, label);
      else next.delete(id);
      return next;
    });
  }, []);
  const router = useRouter();
  const [historyId] = useState(() => crypto.randomUUID());
  const historyView = useLocation({ select: location => location.state.chatResultView });
  const previousHistoryView = useRef(historyView);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const rememberOpening = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
    const split = document.activeElement?.closest<HTMLElement>('[data-slot="chat-split"]');
    const narrow =
      window.matchMedia('(max-width: 767px)').matches || (!!split && split.clientWidth < canvasSplitMinWidth);
    if (onOpenItem || !narrow) return;
    const location = router.state.location;
    if (location.state.chatResultView === historyId) return;
    void router.commitLocation({
      ...location,
      state: { ...location.state, chatResultView: historyId },
      resetScroll: false,
      hashScrollIntoView: false,
      ignoreBlocker: true,
    });
  }, [router, historyId, onOpenItem]);
  useEffect(() => {
    if (historyView === historyId) dispatch({ type: 'visibility', open: true });
    else if (previousHistoryView.current === historyId) dispatch({ type: 'visibility', open: false });
    previousHistoryView.current = historyView;
  }, [historyView, historyId]);
  useEffect(() => {
    const returning = wasOpen.current && !open;
    wasOpen.current = open;
    if (!returning) return;
    const frame = requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (focused !== document.body && !focused?.closest('[data-slot="canvas"]')) return;
      const target = opener.current?.isConnected
        ? opener.current
        : document.querySelector<HTMLElement>('[aria-label="Conversation"]');
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);
  const setOpen = useCallback(
    (next: boolean) => {
      if (next) rememberOpening();
      else if (router.state.location.state.chatResultView === historyId) router.history.back();
      dispatch({ type: 'visibility', open: next });
    },
    [rememberOpening, router, historyId],
  );
  const show = useCallback(
    (item: CanvasItem) => {
      rememberOpening();
      dispatch({ type: 'show', item });
      setAnnouncement(onOpenItem ? '' : `Opened ${item.title}.`);
      onOpenItem?.();
    },
    [rememberOpening, onOpenItem],
  );
  const update = useCallback((id: string, patch: Partial<Omit<CanvasItem, 'id'>>) => {
    dispatch({ type: 'update', id, patch });
  }, []);
  const select = useCallback((id: string) => dispatch({ type: 'select', id }), []);
  const close = useCallback(
    (id: string) => {
      if (items.length === 1 && items[0]?.id === id) setOpen(false);
      dispatch({ type: 'close', id });
    },
    [items, setOpen],
  );
  const value = useMemo<Canvas>(
    () => ({
      actionMutations,
      setActionMutation,
      googleMutations,
      setGoogleMutation,
      composerRequest,
      requestComposer,
      consumeComposer,
      open,
      items,
      activeId,
      show,
      update,
      close,
      select,
      setOpen,
      attention: attention.values().next().value ?? null,
      registerAttention,
      toggle: () => setOpen(!open),
    }),
    [
      open,
      items,
      activeId,
      show,
      update,
      close,
      select,
      setOpen,
      attention,
      registerAttention,
      composerRequest,
      requestComposer,
      consumeComposer,
      googleMutations,
      setGoogleMutation,
      actionMutations,
      setActionMutation,
    ],
  );
  return (
    <CanvasContext value={value}>
      <KeepsEditsContext value={keepsConversation}>
        {children}
        <span className="sr-only" role="status" aria-live="polite">
          {announcement}
        </span>
      </KeepsEditsContext>
    </CanvasContext>
  );
}

export function useCanvas() {
  const canvas = useContext(CanvasContext);
  if (!canvas) throw new Error('useCanvas must be used inside CanvasProvider');
  return canvas;
}

/** File chips render outside chat too; they open the file in a new tab when no canvas is present. */
export function useOptionalCanvas() {
  return useContext(CanvasContext);
}

export function useResultAttention(id: string, active: boolean, label: string) {
  const register = useOptionalCanvas()?.registerAttention;
  useEffect(() => {
    register?.(id, active ? label : null);
    return () => register?.(id, null);
  }, [register, id, active, label]);
}
