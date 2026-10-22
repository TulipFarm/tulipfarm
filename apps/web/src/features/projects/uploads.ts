export type UploadState =
  | { kind: 'waiting' | 'sending' | 'added' }
  | { kind: 'rejected' | 'uncertain'; message: string };
export type Upload = { id: string; revisionId: string; file: File; state: UploadState };

export const uploadLabels: Record<UploadState['kind'], string> = {
  waiting: 'Waiting',
  sending: 'Adding…',
  added: 'Added',
  rejected: 'Not added',
  uncertain: 'Not confirmed',
};
const unconfirmed: UploadState = {
  kind: 'uncertain',
  message: 'We couldn’t confirm whether it was added. Retry sends the same file without adding a copy.',
};

export function queueUploads(files: readonly File[]): Upload[] {
  return files.map(file => ({
    id: crypto.randomUUID(),
    revisionId: crypto.randomUUID(),
    file,
    state: { kind: 'waiting' },
  }));
}

export async function sendUploads(
  uploads: readonly Upload[],
  send: (upload: Upload) => Promise<unknown>,
  confirmedRejection: (error: unknown) => string | null,
  show: (uploads: Upload[]) => void,
) {
  let current = [...uploads];
  const set = (id: string, state: UploadState) => {
    current = current.map(upload => (upload.id === id ? { ...upload, state } : upload));
    show(current);
  };
  for (const upload of uploads) {
    if (upload.state.kind !== 'waiting') continue;
    set(upload.id, { kind: 'sending' });
    try {
      await send(upload);
      set(upload.id, { kind: 'added' });
    } catch (error) {
      const message = confirmedRejection(error);
      set(upload.id, message === null ? unconfirmed : { kind: 'rejected', message });
    }
  }
  return current;
}

/** One project's upload results. `running` stays true until every file in the batch has an outcome. */
export type UploadBatch = { uploads: readonly Upload[]; running: boolean };
const idle: UploadBatch = { uploads: [], running: false };

/** Batches live for the browser tab, not the page: leaving a project keeps its batch sending and its results for the return. */
export function createUploadQueue(transferring: (active: boolean) => void) {
  let batches: ReadonlyMap<string, UploadBatch> = new Map();
  const listeners = new Set<() => void>();
  let warning = false;
  const batch = (key: string) => batches.get(key) ?? idle;
  function put(key: string, next: UploadBatch) {
    const updated = new Map(batches);
    if (next.uploads.length || next.running) updated.set(key, next);
    else updated.delete(key);
    batches = updated;
    const active = [...updated.values()].some(item => item.running);
    if (active !== warning) {
      warning = active;
      transferring(active);
    }
    for (const listener of listeners) listener();
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    batch,
    /** Sends the waiting files in `uploads`. Returns `null` without sending while an earlier batch for the same key is still running. */
    async send(
      key: string,
      uploads: readonly Upload[],
      send: (upload: Upload) => Promise<unknown>,
      confirmedRejection: (error: unknown) => string | null,
    ) {
      if (batch(key).running) return null;
      put(key, { uploads, running: true });
      try {
        return await sendUploads(uploads, send, confirmedRejection, shown =>
          put(key, { uploads: shown, running: true }),
        );
      } finally {
        put(key, { uploads: batch(key).uploads, running: false });
      }
    },
    replace(key: string, uploads: readonly Upload[]) {
      if (!batch(key).running) put(key, { uploads, running: false });
    },
  };
}

const warnBeforeUnload = (event: BeforeUnloadEvent) => {
  event.preventDefault();
  event.returnValue = '';
};
export const projectUploads = createUploadQueue(active => {
  if (active) window.addEventListener('beforeunload', warnBeforeUnload);
  else window.removeEventListener('beforeunload', warnBeforeUnload);
});

export function confirmUploads(
  uploads: readonly Upload[],
  saved: readonly { id: string; revisionId: string }[],
): readonly Upload[] {
  const stored = new Set(saved.map(file => `${file.id} ${file.revisionId}`));
  const confirmed = (upload: Upload) =>
    (upload.state.kind === 'uncertain' || upload.state.kind === 'rejected') &&
    stored.has(`${upload.id} ${upload.revisionId}`);
  return uploads.some(confirmed)
    ? uploads.map(upload => (confirmed(upload) ? { ...upload, state: { kind: 'added' } } : upload))
    : uploads;
}

export function addedMessage(uploads: readonly Upload[]) {
  return uploads.length === 1 ? `${uploads[0]!.file.name} added.` : `${uploads.length} files added.`;
}

export function uploadSummary(uploads: readonly Upload[]) {
  const next =
    uploads.find(upload => upload.state.kind === 'sending') ?? uploads.find(upload => upload.state.kind === 'waiting');
  if (next) return `Adding ${next.file.name}…`;
  const count = (kind: UploadState['kind']) => uploads.filter(upload => upload.state.kind === kind).length;
  return (
    [
      ['added', 'added'],
      ['rejected', 'not added'],
      ['uncertain', 'not confirmed'],
    ] as const
  )
    .flatMap(([kind, label]) => (count(kind) ? [`${count(kind)} ${label}`] : []))
    .join(', ');
}
