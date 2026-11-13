/** A source as the page last read it. `loading` is the browser's own state before the first read answers. */
export type SourceStatus = 'loading' | 'ready' | 'empty' | 'restricted' | 'unavailable' | 'failed';
export type LoadedSource = { status: Exclude<SourceStatus, 'loading'>; loadedAt: string };

export type ActionAvailability = 'available' | 'restricted' | 'unavailable';
export type ActionKind = 'open-page' | 'open-record' | 'run-workflow' | 'ask-agent';
export type PageAction = { id: string; label: string; kind: ActionKind; availability: ActionAvailability };

/** In a draft, only these act on real data, so only these ask the editor to confirm first. */
const confirmedKinds = new Set<ActionKind>(['run-workflow', 'ask-agent']);
export type PageContent = {
  draft: boolean;
  navigation: { slug: string; title: string }[];
  page: { slug: string; title: string; surface: unknown[]; actions: PageAction[] };
};

/** What the server did with an accepted action. */
export type ActionResult =
  | { kind: 'open-page'; page: string; row?: string | undefined }
  | { kind: 'open-record'; tableId: string; recordId: string }
  | { kind: 'run-workflow'; runId: string }
  | { kind: 'ask-agent'; taskId: string };

/**
 * One press of one button. A press that fails keeps its request ID, so pressing again with the same values is a retry
 * the server recognises rather than a second run. No entry for an action means it is idle.
 */
export type Press = {
  requestId: string;
  actionId: string;
  context: Record<string, unknown>;
  labels?: Record<string, string> | undefined;
  state: 'confirming' | 'sent' | 'running' | 'succeeded' | 'failed';
  result?: ActionResult;
  message?: string;
};

export type PageData = {
  phase: 'loading' | 'loaded' | 'failed';
  sources: Record<string, LoadedSource>;
  /** The server's `updateDataModel` message for `/sources`, fed to the surface as is. */
  model: unknown;
  loadedAt: string | null;
};

export type PageView =
  | { kind: 'opening'; key: string }
  | { kind: 'not-found'; key: string }
  | { kind: 'failed'; key: string; message: string }
  | { kind: 'ended' }
  | { kind: 'open'; key: string; content: PageContent; data: PageData; presses: Record<string, Press> };

export type PageEvent =
  | { type: 'open'; key: string }
  | { type: 'opened'; key: string; content: PageContent }
  | { type: 'open-failed'; key: string; status: number; message: string }
  | { type: 'load' }
  | { type: 'loaded'; model: unknown; sources: Record<string, LoadedSource> }
  | { type: 'load-failed'; status: number }
  | {
      type: 'press';
      actionId: string;
      context: Record<string, unknown>;
      labels?: Record<string, string> | undefined;
      requestId: string;
    }
  | { type: 'confirm'; actionId: string }
  | { type: 'cancel'; actionId: string }
  | { type: 'accepted'; actionId: string; result: ActionResult }
  | { type: 'refused'; actionId: string; status: number; message: string };

const emptyData: PageData = { phase: 'loading', sources: {}, model: null, loadedAt: null };

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export const initialPage = (key: string): PageView => ({ kind: 'opening', key });

/**
 * The life of one open page: opening it, loading its sources, and each button press. Once access ends nothing moves it
 * again, so no further load or action starts from that page.
 */
export function pageReducer(view: PageView, event: PageEvent): PageView {
  if (view.kind === 'ended') return view;
  switch (event.type) {
    case 'open':
      return { kind: 'opening', key: event.key };
    case 'opened':
      if (view.key !== event.key) return view;
      return view.kind === 'open'
        ? { ...view, content: event.content }
        : { kind: 'open', key: event.key, content: event.content, data: emptyData, presses: {} };
    case 'open-failed':
      if (view.key !== event.key) return view;
      // A page that was open and now answers 404 was taken away mid-session; a first 404 is an unknown page.
      if (event.status === 403 || (event.status === 404 && view.kind === 'open')) return { kind: 'ended' };
      if (event.status === 404) return { kind: 'not-found', key: event.key };
      return { kind: 'failed', key: event.key, message: event.message };
  }
  if (view.kind !== 'open') return view;
  const update = (actionId: string, change: Partial<Press>): PageView => {
    const current = view.presses[actionId];
    return current ? { ...view, presses: { ...view.presses, [actionId]: { ...current, ...change } } } : view;
  };
  switch (event.type) {
    case 'load':
      return { ...view, data: { ...view.data, phase: 'loading' } };
    case 'loaded':
      return {
        ...view,
        data: {
          phase: 'loaded',
          sources: event.sources,
          model: event.model,
          loadedAt: latest(Object.values(event.sources).map(source => source.loadedAt)),
        },
      };
    case 'load-failed':
      if (event.status === 403 || event.status === 404) return { kind: 'ended' };
      return { ...view, data: { ...view.data, phase: 'failed' } };
    case 'press': {
      const current = view.presses[event.actionId];
      if (current?.state === 'sent' || current?.state === 'confirming') return view;
      const retry = current?.state === 'failed' && same(current.context, event.context);
      const kind = view.content.page.actions.find(action => action.id === event.actionId)?.kind;
      const confirm = view.content.draft && (kind === undefined || confirmedKinds.has(kind));
      return {
        ...view,
        presses: {
          ...view.presses,
          [event.actionId]: {
            requestId: retry ? current.requestId : event.requestId,
            actionId: event.actionId,
            context: event.context,
            labels: event.labels,
            state: confirm ? 'confirming' : 'sent',
          },
        },
      };
    }
    case 'confirm':
      return view.presses[event.actionId]?.state === 'confirming' ? update(event.actionId, { state: 'sent' }) : view;
    case 'cancel': {
      if (view.presses[event.actionId]?.state !== 'confirming') return view;
      const { [event.actionId]: _cancelled, ...presses } = view.presses;
      return { ...view, presses };
    }
    case 'accepted':
      return update(event.actionId, {
        state: event.result.kind === 'run-workflow' ? 'running' : 'succeeded',
        result: event.result,
      });
    case 'refused':
      // 404 is the app gone for this member; 403 here is only this action being refused.
      if (event.status === 404) return { kind: 'ended' };
      return update(event.actionId, { state: 'failed', message: event.message });
  }
}

function latest(times: string[]) {
  return times.reduce<string | null>((found, time) => (found === null || time > found ? time : found), null);
}

/** How one source shows now. Before the first read every source is loading; a source the read left out is unavailable. */
export function sourceStatus(data: PageData, id: string): SourceStatus {
  const source = data.sources[id];
  if (source) return source.status;
  if (data.phase === 'loading') return 'loading';
  return data.phase === 'failed' ? 'failed' : 'unavailable';
}

const statusOrder: SourceStatus[] = ['failed', 'unavailable', 'restricted', 'loading', 'empty', 'ready'];

/** The state a component shows when it reads several sources: the one that most stops it drawing. */
export function componentStatus(data: PageData, ids: string[]): SourceStatus {
  const statuses = new Set(ids.map(id => sourceStatus(data, id)));
  return statusOrder.find(status => statuses.has(status)) ?? 'ready';
}

/** A press waiting on the server locks the page's fields and buttons, so a form cannot be sent twice. */
export const pageLocked = (view: PageView) =>
  view.kind === 'open' && Object.values(view.presses).some(press => press.state === 'sent');

/** The press waiting for the editor to confirm it, in a draft. */
export const confirming = (view: PageView) =>
  view.kind === 'open' ? Object.values(view.presses).find(press => press.state === 'confirming') : undefined;

/** The source IDs a component's own properties read through `/sources/<id>` bindings. */
export function sourcesRead(props: unknown): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 16 || typeof value !== 'object' || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    for (const path of [record['@path'], 'componentId' in record ? record.path : undefined]) {
      const match = typeof path === 'string' ? /^\/sources\/([^/]+)/.exec(path) : null;
      if (match) found.add(match[1]!.replaceAll('~1', '/').replaceAll('~0', '~'));
    }
    for (const item of Object.values(record)) visit(item, depth + 1);
  };
  visit(props, 0);
  return [...found];
}
