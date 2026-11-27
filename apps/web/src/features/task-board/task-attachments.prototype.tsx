// PROTOTYPE, throw away. Three layouts for task attachments on the task page, switched by ?variant=A|B|C.
// Mock files live in memory; nothing uploads.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { AttachmentDropzone, AttachmentGroup, FileAttachment, type AttachmentFile } from '@tulipfarm/sprout/attachment';
import { Button } from '@tulipfarm/sprout/button';
import { FileRenderersProvider } from '@tulipfarm/sprout/file-viewer';
import { fileRenderers } from '@/features/files/viewer/renderers';
import { formatFileSize } from '@/lib/file-viewer';

export const taskAttachmentsPrototypeEnabled = import.meta.env.DEV;

const variants = ['A', 'B', 'C'] as const;
type Variant = (typeof variants)[number];
const names: Record<Variant, string> = { A: 'Gallery under description', B: 'Compact strip + paperclip', C: 'Files in the side panel' };

function shot(label: string, hue: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="100%" height="100%" fill="hsl(${hue},40%,92%)"/><rect x="40" y="40" width="1200" height="60" rx="8" fill="hsl(${hue},30%,80%)"/><rect x="40" y="130" width="360" height="620" rx="8" fill="white"/><rect x="430" y="130" width="810" height="300" rx="8" fill="white"/><text x="640" y="560" font-size="56" text-anchor="middle" font-family="sans-serif" fill="hsl(${hue},40%,35%)">${label}</text></svg>`;
  const file = new File([svg], `${label.toLowerCase().replace(/\s+/g, '-')}.svg`, { type: 'image/svg+xml' });
  return file;
}
const seed = (): File[] => [
  shot('Login error', 0),
  shot('Network tab', 210),
  new File(['%PDF-1.4 mock'], 'crash-report.pdf', { type: 'application/pdf' }),
];
const commentSeed = (): File[] => [shot('After fix', 140)];

type Store = { description: File[]; comment: File[]; draft: File[] };
let state: Store = { description: seed(), comment: commentSeed(), draft: [] };
const listeners = new Set<() => void>();
const set = (next: Partial<Store>) => {
  state = { ...state, ...next };
  for (const l of listeners) l();
};
const useStore = () =>
  useSyncExternalStore(
    l => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  );

function variantOf(): Variant {
  const v = new URLSearchParams(window.location.search).get('variant');
  return variants.includes(v as Variant) ? (v as Variant) : 'A';
}
export function useTaskAttachmentsVariant() {
  return useSyncExternalStore(
    l => (window.addEventListener('popstate', l), () => window.removeEventListener('popstate', l)),
    variantOf,
  );
}

const previews = new WeakMap<File, string>();
const previewOf = (file: File) => {
  if (!file.type.startsWith('image/')) return undefined;
  if (!previews.has(file)) previews.set(file, URL.createObjectURL(file));
  return previews.get(file);
};
const asFile = (file: File, i: number): AttachmentFile => ({
  id: `${file.name}-${i}`,
  url: previewOf(file),
  name: file.name,
  mediaType: file.type,
  size: formatFileSize(file.size),
  state: 'ready',
  source: { kind: 'local', file },
});

function Files({
  files,
  variant,
  remove,
}: {
  files: File[];
  variant: 'grid' | 'chip' | 'list';
  remove?: (i: number) => void;
}) {
  if (!files.length) return null;
  return (
    <FileRenderersProvider renderers={fileRenderers}>
      <AttachmentGroup
        variant={variant === 'chip' ? 'carousel' : variant === 'grid' ? 'grid' : 'list'}
        aria-label="Attached files"
      >
        {files.map((file, i) => (
          <FileAttachment
            key={`${file.name}-${i}`}
            variant={variant}
            viewable
            preview
            file={asFile(file, i)}
            onRemove={remove ? () => remove(i) : undefined}
          />
        ))}
      </AttachmentGroup>
    </FileRenderersProvider>
  );
}

function PickButton({ add, label = 'Attach' }: { add: (files: File[]) => void; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={e => {
          add([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      <Button type="button" variant="ghost" size="sm" onClick={() => input.current?.click()}>
        📎 {label}
      </Button>
    </>
  );
}

/** Pasting anywhere on the page adds files to the description, as a stand-in for focused paste targets. */
function usePaste(add: (files: File[]) => void) {
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) {
        e.preventDefault();
        add(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [add]);
}

const addDescription = (files: File[]) => set({ description: [...state.description, ...files].slice(0, 10) });
const removeDescription = (i: number) => set({ description: state.description.filter((_, j) => j !== i) });
const addDraft = (files: File[]) => set({ draft: [...state.draft, ...files].slice(0, 5) });
const removeDraft = (i: number) => set({ draft: state.draft.filter((_, j) => j !== i) });

/** Below the description. */
export function DescriptionAttachmentsPrototype() {
  const variant = useTaskAttachmentsVariant();
  const store = useStore();
  usePaste(addDescription);
  if (variant === 'A')
    return (
      <div className="space-y-2">
        <Files files={store.description} variant="grid" remove={removeDescription} />
        <AttachmentDropzone onFiles={addDescription} accept="*/*" />
        <p className="text-xs text-muted-foreground">Paste a screenshot, drop files, or choose them. Anyone who can see this task can open them.</p>
      </div>
    );
  if (variant === 'B')
    return (
      <div className="space-y-1">
        <Files files={store.description} variant="chip" remove={removeDescription} />
        <div className="flex items-center gap-2">
          <PickButton add={addDescription} />
          <span className="text-xs text-muted-foreground">or paste a screenshot</span>
        </div>
      </div>
    );
  return null;
}

/** In the properties side panel. */
export function AsideAttachmentsPrototype() {
  const variant = useTaskAttachmentsVariant();
  const store = useStore();
  if (variant !== 'C') return null;
  return (
    <section aria-label="Files" className="space-y-2 border-t pt-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Files · {store.description.length}</h2>
        <PickButton add={addDescription} label="Add" />
      </div>
      <Files files={store.description} variant="list" remove={removeDescription} />
      <p className="text-xs text-muted-foreground">Paste a screenshot anywhere on the page.</p>
    </section>
  );
}

/** A mock comment with a file and a mock comment box, shown above the real activity thread. */
export function CommentAttachmentsPrototype() {
  const variant = useTaskAttachmentsVariant();
  const store = useStore();
  const fileLook = variant === 'A' ? 'grid' : variant === 'B' ? 'chip' : 'list';
  return (
    <div className="space-y-3 rounded-md border border-dashed p-3">
      <p className="text-xs font-medium text-muted-foreground">Prototype comment</p>
      <div className="space-y-2">
        <p className="text-sm">
          <span className="font-medium">Dhruv</span> · Fixed on staging, see the screenshot.
        </p>
        <Files files={store.comment} variant={fileLook} />
      </div>
      <div
        className="space-y-2 rounded-md border p-2"
        onDragOver={e => e.preventDefault()}
        onDrop={e => {
          e.preventDefault();
          addDraft([...e.dataTransfer.files]);
        }}
      >
        <textarea className="w-full resize-none bg-transparent text-sm outline-none" rows={2} placeholder="Write a comment…" />
        <Files files={store.draft} variant={variant === 'A' ? 'grid' : 'chip'} remove={removeDraft} />
        <div className="flex items-center justify-between">
          <PickButton add={addDraft} label={variant === 'C' ? 'Add file' : 'Attach'} />
          <Button
            size="sm"
            onClick={() => set({ comment: [...state.comment, ...state.draft], draft: [] })}
            disabled={!store.draft.length}
          >
            Comment
          </Button>
        </div>
      </div>
    </div>
  );
}

export function TaskAttachmentsSwitcher() {
  const variant = useTaskAttachmentsVariant();
  const go = (step: number) => {
    const next = variants[(variants.indexOf(variant) + step + variants.length) % variants.length]!;
    const url = new URL(window.location.href);
    url.searchParams.set('variant', next);
    window.history.replaceState(window.history.state, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('input,textarea,[contenteditable="true"]')) return;
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full bg-black px-4 py-2 text-sm text-white shadow-lg">
      <button type="button" onClick={() => go(-1)} aria-label="Previous variant">
        ←
      </button>
      <span>
        {variant} ({names[variant]})
      </span>
      <button type="button" onClick={() => go(1)} aria-label="Next variant">
        →
      </button>
    </div>
  );
}
