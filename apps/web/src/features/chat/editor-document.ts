import type { JSONContent } from '@tiptap/core';
import { chatDocumentSchema } from '@tulipfarm/conversations/rich-content';

type DraftNode = {
  type?: string;
  attrs?: Record<string, unknown> | undefined;
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[] | undefined;
  content?: DraftNode[] | undefined;
};
export type ChatDraft = { version: 1; doc: DraftNode };

export function editorDocument(node: DraftNode): JSONContent {
  const { content, marks, ...rest } = node;
  return { ...rest, ...(content ? { content: content.map(editorDocument) } : {}), ...(marks ? { marks } : {}) };
}

function messageNode(node: DraftNode): JSONContent {
  if (node.type === 'packageReference')
    return { type: 'text', text: typeof node.attrs?.url === 'string' ? node.attrs.url : '' };
  const { content, marks, ...rest } = node;
  const result: JSONContent = { ...rest };
  if (content) result.content = content.map(messageNode);
  if (marks)
    result.marks = marks.map(mark => {
      if (mark.type !== 'link' || !mark.attrs) return mark;
      const attrs = { ...mark.attrs };
      // These control the editor's DOM, not the persisted link destination.
      for (const key of ['target', 'rel', 'class', 'title']) delete attrs[key];
      return { ...mark, attrs };
    });
  if (node.type === 'orderedList' && node.attrs) {
    result.attrs = { ...node.attrs };
    delete result.attrs.type;
  }
  if (node.type === 'hardBreak' || node.type === 'fileReference') delete result.marks;
  return result;
}

export function parseChatDraft(draft: ChatDraft) {
  return chatDocumentSchema.safeParse({ ...draft, doc: messageNode(draft.doc) });
}
