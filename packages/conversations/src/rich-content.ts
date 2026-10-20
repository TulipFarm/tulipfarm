import { z } from 'zod';
import { googleFileIdSchema } from '@tulipfarm/google-workspace/public-contracts';

const validUnicode = (value: string) =>
  !value.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const textSchema = z.string().refine(validUnicode, 'Text must be valid Unicode');
const safeLink = z
  .url()
  .refine(
    value => URL.canParse(value) && ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol),
    'Unsupported link protocol',
  );

const markSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('bold') }),
  z.strictObject({ type: z.literal('italic') }),
  z.strictObject({ type: z.literal('strike') }),
  z.strictObject({ type: z.literal('code') }),
  z.strictObject({ type: z.literal('link'), attrs: z.strictObject({ href: safeLink }) }),
]);

type TextNode = { type: 'text'; text: string; marks?: z.infer<typeof markSchema>[] | undefined };
type HardBreakNode = { type: 'hardBreak' };
export type ChatFileReference = { source: 'tulipfarm' | 'google'; id: string };
type FileReferenceNode = { type: 'fileReference'; attrs: ChatFileReference };
type InlineNode = TextNode | HardBreakNode | FileReferenceNode;
type ParagraphNode = { type: 'paragraph'; content?: InlineNode[] | undefined };
type HeadingNode = { type: 'heading'; attrs: { level: 1 | 2 | 3 }; content?: InlineNode[] | undefined };
type BlockquoteNode = { type: 'blockquote'; content: BlockNode[] };
type ListItemNode = { type: 'listItem'; content: BlockNode[] };
type BulletListNode = { type: 'bulletList'; content: ListItemNode[] };
type OrderedListNode = { type: 'orderedList'; attrs?: { start: number } | undefined; content: ListItemNode[] };
type CodeBlockNode = {
  type: 'codeBlock';
  attrs?: { language: string | null } | undefined;
  content?: TextNode[] | undefined;
};
type BlockNode = ParagraphNode | HeadingNode | BlockquoteNode | BulletListNode | OrderedListNode | CodeBlockNode;

const textNodeSchema: z.ZodType<TextNode> = z.strictObject({
  type: z.literal('text'),
  text: textSchema.min(1),
  marks: z
    .array(markSchema)
    .max(5)
    .refine(marks => new Set(marks.map(mark => mark.type)).size === marks.length, 'Duplicate mark')
    .optional(),
});
const fileReferenceSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('tulipfarm'), id: z.uuid() }),
  z.strictObject({ source: z.literal('google'), id: googleFileIdSchema }),
]);
const inlineNodeSchema: z.ZodType<InlineNode> = z.union([
  textNodeSchema,
  z.strictObject({ type: z.literal('hardBreak') }),
  z.strictObject({ type: z.literal('fileReference'), attrs: fileReferenceSchema }),
]);
const blockNodeSchema: z.ZodType<BlockNode> = z.lazy(() =>
  z.union([
    z.strictObject({ type: z.literal('paragraph'), content: z.array(inlineNodeSchema).max(256).optional() }),
    z.strictObject({
      type: z.literal('heading'),
      attrs: z.strictObject({ level: z.union([z.literal(1), z.literal(2), z.literal(3)]) }),
      content: z.array(inlineNodeSchema).max(256).optional(),
    }),
    z.strictObject({ type: z.literal('blockquote'), content: z.array(blockNodeSchema).min(1).max(64) }),
    z.strictObject({ type: z.literal('bulletList'), content: z.array(listItemSchema).min(1).max(64) }),
    z.strictObject({
      type: z.literal('orderedList'),
      attrs: z.strictObject({ start: z.number().int().min(1).max(1_000_000) }).optional(),
      content: z.array(listItemSchema).min(1).max(64),
    }),
    z.strictObject({
      type: z.literal('codeBlock'),
      attrs: z.strictObject({ language: textSchema.min(1).max(64).nullable() }).optional(),
      content: z
        .array(textNodeSchema.refine(node => !node.marks?.length, 'Code block text cannot have marks'))
        .max(64)
        .optional(),
    }),
  ]),
);
const listItemSchema: z.ZodType<ListItemNode> = z.lazy(() =>
  z.strictObject({
    type: z.literal('listItem'),
    content: z.array(blockNodeSchema).min(1).max(64),
  }),
);
const docSchema = z.strictObject({ type: z.literal('doc'), content: z.array(blockNodeSchema).min(1).max(128) });
export type ChatDocument = { version: 1; doc: { type: 'doc'; content: BlockNode[] } };

export const chatDocumentSchema: z.ZodType<ChatDocument> = z
  .strictObject({
    version: z.literal(1),
    doc: docSchema,
  })
  .superRefine((document, context) => {
    if (new TextEncoder().encode(JSON.stringify(document)).length > 131_072) {
      context.addIssue({ code: 'custom', message: 'Rich content exceeds 128 KiB' });
      return;
    }
    let count = 0;
    const visit = (node: BlockNode | InlineNode | ListItemNode | ChatDocument['doc'], depth: number) => {
      count += 1;
      if (count > 512) context.addIssue({ code: 'custom', message: 'Rich content has too many nodes' });
      if (depth > 16) context.addIssue({ code: 'custom', message: 'Rich content is nested too deeply' });
      if ('content' in node && node.content) for (const child of node.content) visit(child, depth + 1);
    };
    visit(document.doc, 0);
  });

function inlineText(nodes: readonly InlineNode[] | undefined) {
  return (nodes ?? [])
    .map(node => (node.type === 'text' ? node.text : node.type === 'hardBreak' ? '\n' : '\uFFFC'))
    .join('');
}

function blockText(node: BlockNode, depth = 0): string {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return inlineText(node.content);
    case 'codeBlock':
      return (node.content ?? []).map(child => child.text).join('');
    case 'blockquote':
      return node.content.map(child => blockText(child, depth)).join('\n\n');
    case 'bulletList':
      return node.content
        .map(item => `${'  '.repeat(depth)}- ${item.content.map(child => blockText(child, depth + 1)).join('\n')}`)
        .join('\n');
    case 'orderedList': {
      const start = node.attrs?.start ?? 1;
      return node.content
        .map(
          (item, index) =>
            `${'  '.repeat(depth)}${start + index}. ${item.content.map(child => blockText(child, depth + 1)).join('\n')}`,
        )
        .join('\n');
    }
  }
}

export function chatDocumentText(value: ChatDocument) {
  const document = chatDocumentSchema.parse(value);
  return document.doc.content.map(node => blockText(node)).join('\n\n');
}

export function chatDocumentReferences(value: ChatDocument) {
  const document = chatDocumentSchema.parse(value);
  const references: ChatFileReference[] = [];
  const visit = (node: BlockNode | InlineNode | ListItemNode | ChatDocument['doc']) => {
    if (node.type === 'fileReference') references.push(node.attrs);
    if ('content' in node && node.content) for (const child of node.content) visit(child);
  };
  visit(document.doc);
  return references;
}
