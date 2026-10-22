import { Extension, Node, mergeAttributes, type Editor, type Range } from '@tiptap/core';
import type { ChatDocument } from '@tulipfarm/conversations/rich-content';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
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
  items: readonly EditorSuggestionItem[];
  active: number;
  select: (index: number) => void;
} | null;

export const emptyChatDocument: ChatDocument['doc'] = { type: 'doc', content: [{ type: 'paragraph' }] };

export function EditorSuggestionPanel({
  state,
  loading = false,
  empty,
  error,
}: {
  state: NonNullable<EditorSuggestionState>;
  loading?: boolean;
  empty: string;
  error?: { message: string; retry: () => void };
}) {
  const status = error ? (
    <MentionStatus tone="error" action={{ label: 'Retry', onAction: error.retry }}>
      {error.message}
    </MentionStatus>
  ) : loading ? (
    <MentionStatus tone="loading">Searching…</MentionStatus>
  ) : state.items.length ? undefined : (
    <MentionStatus tone="empty">{empty}</MentionStatus>
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

export function suggestionExtension(options: {
  key: string;
  char: string;
  label: string;
  allowSpaces?: boolean;
  items: (query: string, signal: AbortSignal, editor: Editor) => Promise<EditorSuggestionItem[]>;
  onState: (state: EditorSuggestionState) => void;
}) {
  return Extension.create({
    name: `${options.key}Suggestion`,
    addProseMirrorPlugins() {
      return [
        Suggestion<EditorSuggestionItem>({
          editor: this.editor,
          pluginKey: new PluginKey(options.key),
          char: options.char,
          allowSpaces: options.allowSpaces ?? true,
          startOfLine: false,
          items: ({ query, signal, editor }) => options.items(query, signal, editor),
          command: ({ editor, range, props }) => props.apply(editor, range),
          render: () => {
            let current: SuggestionProps<EditorSuggestionItem> | null = null;
            let active = 0;
            const publish = () => {
              if (!current) return;
              const selected = Math.min(active, Math.max(0, current.items.length - 1));
              options.onState({
                key: options.key,
                label: options.label,
                items: current.items,
                active: selected,
                select: index => {
                  const item = current?.items[index];
                  if (item) current?.command(item);
                },
              });
            };
            return {
              onStart: props => {
                current = props;
                active = 0;
                publish();
              },
              onUpdate: props => {
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
