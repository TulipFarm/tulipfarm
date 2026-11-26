import type { ReactNode } from 'react';
import { chatDocumentSchema, type ChatDocument, type ChatFileReference } from '@tulipfarm/conversations/rich-content';
import { MessageRichText } from '@tulipfarm/sprout/message-rich-text';
import type { RichTextValue } from '@tulipfarm/sprout/rich-text-editor';
import { PackagePill, packageLinkParts } from './package-reference';

/** A sent message with file chips and package pills. Plain text shows as typed. */
export function RichMessage({
  content,
  text,
  file,
}: {
  content?: ChatDocument | undefined;
  text?: string;
  file: (reference: ChatFileReference) => ReactNode;
}) {
  const document = content ? chatDocumentSchema.parse(content) : null;
  const value = document ? withPackages(document.doc as RichTextValue) : plainDocument(text ?? '');
  return (
    <div className="wrap-break-word">
      <MessageRichText
        value={value}
        renderNode={node =>
          node.type === 'fileReference' ? (
            file(node.attrs as ChatFileReference)
          ) : node.type === 'packageReference' ? (
            <PackagePill url={String(node.attrs?.url)} />
          ) : null
        }
      />
    </div>
  );
}

function packageNodes(text: string, marks?: RichTextValue['marks']): RichTextValue[] {
  return packageLinkParts(text).map(part =>
    'url' in part
      ? { type: 'packageReference', attrs: { url: part.url } }
      : { type: 'text', text: part.text, ...(marks ? { marks } : {}) },
  );
}

// Marketplace package links in a sent message show as package pills, as they did in the composer.
function withPackages(node: RichTextValue): RichTextValue {
  if (node.type === 'codeBlock' || !node.content) return node;
  return {
    ...node,
    content: node.content.flatMap(child =>
      child.type === 'text' && !child.marks?.some(mark => mark.type === 'code' || mark.type === 'link')
        ? packageNodes(child.text ?? '', child.marks)
        : [withPackages(child)],
    ),
  };
}

function plainDocument(text: string): RichTextValue {
  return {
    type: 'doc',
    content: text.split(/\n{2,}/).map(paragraph => ({
      type: 'paragraph',
      content: paragraph
        .split('\n')
        .flatMap((line, index) => [...(index ? [{ type: 'hardBreak' }] : []), ...packageNodes(line)]),
    })),
  };
}
