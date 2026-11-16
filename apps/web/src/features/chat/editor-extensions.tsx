import { Extension, Node, mergeAttributes, type Editor, type Range } from '@tiptap/core';
import type { ChatDocument } from '@tulipfarm/conversations/rich-content';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { ReactNode } from 'react';
import { FileTypeIcon } from '@tulipfarm/sprout/attachment';
import { MentionList, MentionOption, MentionStatus } from '@tulipfarm/sprout/mention-list';

export type FileNodeMetadata = { name: string; mediaType: string };
export type EditorSuggestionItem = {
  id: string;
  title: string;
  description?: string;
  media?: ReactNode;
  apply: (editor: Editor, range: Range) => void;
};
export type EditorSuggestionState = {
  key: string;
  label: string;
  query: string;
  items: readonly EditorSuggestionItem[];
  active: number;
  loading: boolean;
  failed: boolean;
  retry: () => void;
  select: (index: number) => void;
} | null;

export const emptyChatDocument: ChatDocument['doc'] = { type: 'doc', content: [{ type: 'paragraph' }] };

export function EditorSuggestionPanel({
  state,
  loading = 'Searching…',
  empty,
  error = { message: 'Couldn’t load suggestions. Check your connection, then retry.', retry: 'Retry' },
}: {
  state: NonNullable<EditorSuggestionState>;
  loading?: string;
  empty: string | ((query: string) => string);
  error?: { message: string; retry: string };
}) {
  const status = state.failed ? (
    <MentionStatus tone="error" action={{ label: error.retry, onAction: state.retry }}>
      {error.message}
    </MentionStatus>
  ) : state.items.length ? undefined : state.loading ? (
    <MentionStatus tone="loading">{loading}</MentionStatus>
  ) : (
    <MentionStatus tone="empty">{typeof empty === 'string' ? empty : empty(state.query)}</MentionStatus>
  );
  return (
    <MentionList
      id={`${state.key}-suggestions`}
      label={state.label}
      status={status}
      announcement={
        state.items.length
          ? `${state.items.length} ${state.items.length === 1 ? 'option' : 'options'}. Use Up and Down to choose, Enter to select, Escape to close.`
          : undefined
      }
    >
      {state.items.map((item, index) => (
        <MentionOption
          key={item.id}
          id={`${state.key}-option-${index}`}
          active={index === state.active}
          onSelect={() => state.select(index)}
          media={item.media}
          title={item.title}
          description={item.description}
        />
      ))}
    </MentionList>
  );
}

export function fileReferenceExtension(resolve: (source: string, id: string) => FileNodeMetadata | null) {
  return Node.create({
    name: 'fileReference',
    inline: true,
    group: 'inline',
    atom: true,
    selectable: true,
    addAttributes() {
      return {
        source: { default: 'tulipfarm' },
        id: { default: '' },
      };
    },
    parseHTML() {
      return [{ tag: 'span[data-file-reference]' }];
    },
    renderHTML({ HTMLAttributes }) {
      return ['span', mergeAttributes(HTMLAttributes, { 'data-file-reference': '' })];
    },
    addNodeView() {
      return ReactNodeViewRenderer((props: NodeViewProps) => {
        const metadata = resolve(String(props.node.attrs.source), String(props.node.attrs.id));
        return (
          <NodeViewWrapper as="span" contentEditable={false}>
            <span className="mx-0.5 inline-flex max-w-64 items-center gap-1 rounded-md border bg-card px-1.5 py-0.5 align-baseline text-sm text-foreground">
              <FileTypeIcon name={metadata?.name ?? ''} mediaType={metadata?.mediaType ?? ''} />
              <span className="truncate">{metadata?.name ?? 'File'}</span>
            </span>
          </NodeViewWrapper>
        );
      });
    },
  });
}

/**
 * The composer is read-only while a message sends. A read-only editor is no longer focusable, so the
 * browser would move focus to the page; staying focusable keeps the writer's place for the next message.
 */
export const keepFocusExtension = Extension.create({
  name: 'keepFocus',
  addProseMirrorPlugins() {
    return [new Plugin({ props: { attributes: { tabindex: '0' } } })];
  },
});

export function suggestionExtension(options: {
  key: string;
  char: string;
  label: string;
  allowSpaces?: boolean;
  /** Waits this many milliseconds after the last keystroke before loading items. */
  debounce?: number;
  /** Whether the text typed after the trigger character still counts as a query. */
  allow?: (query: string) => boolean;
  items: (query: string, signal: AbortSignal, editor: Editor) => Promise<EditorSuggestionItem[]>;
  onState: (state: EditorSuggestionState) => void;
}) {
  return Extension.create({
    name: `${options.key}Suggestion`,
    addProseMirrorPlugins() {
      let failed = false;
      return [
        Suggestion<EditorSuggestionItem>({
          editor: this.editor,
          pluginKey: new PluginKey(options.key),
          char: options.char,
          allowSpaces: options.allowSpaces ?? true,
          startOfLine: false,
          debounce: options.debounce ?? 0,
          ...(options.allow && {
            allow: ({ state, range }) =>
              options.allow!(state.doc.textBetween(range.from + options.char.length, range.to)),
          }),
          items: async ({ query, signal, editor }) => {
            failed = false;
            try {
              return await options.items(query, signal, editor);
            } catch (error) {
              if (!signal.aborted) failed = true;
              throw error;
            }
          },
          command: ({ editor, range, props }) => props.apply(editor, range),
          render: () => {
            let current: SuggestionProps<EditorSuggestionItem> | null = null;
            let active = 0;
            let retrying: AbortController | null = null;
            const stopRetry = () => {
              retrying?.abort();
              retrying = null;
            };
            const retry = () => {
              const props = current;
              if (!props) return;
              stopRetry();
              const controller = new AbortController();
              retrying = controller;
              failed = false;
              publish();
              options.items(props.query, controller.signal, props.editor).then(
                items => {
                  if (retrying !== controller || !current) return;
                  retrying = null;
                  current = { ...current, items };
                  active = 0;
                  publish();
                },
                () => {
                  if (retrying !== controller) return;
                  retrying = null;
                  failed = true;
                  publish();
                },
              );
            };
            const publish = () => {
              if (!current) return;
              const selected = Math.min(active, Math.max(0, current.items.length - 1));
              options.onState({
                key: options.key,
                label: options.label,
                query: current.query,
                items: current.items,
                active: selected,
                loading: current.loading || retrying !== null,
                failed: !current.loading && retrying === null && failed,
                retry,
                select: index => {
                  const item = current?.items[index];
                  if (item) current?.command(item);
                },
              });
            };
            return {
              onStart: props => {
                stopRetry();
                current = props;
                active = 0;
                publish();
              },
              onUpdate: props => {
                stopRetry();
                current = props;
                active = 0;
                publish();
              },
              onKeyDown: ({ event }: SuggestionKeyDownProps) => {
                if (event.key === 'Escape') {
                  options.onState(null);
                  return true;
                }
                if (!current?.items.length) return false;
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  active = (active + (event.key === 'ArrowDown' ? 1 : current.items.length - 1)) % current.items.length;
                  publish();
                  return true;
                }
                if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
                  current.command(current.items[active]!);
                  return true;
                }
                return false;
              },
              onExit: () => {
                stopRetry();
                current = null;
                options.onState(null);
              },
            };
          },
        }),
      ];
    },
  });
}
