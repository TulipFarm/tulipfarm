import { Fragment, type ReactNode } from 'react';
import type { JSONContent } from '@tiptap/core';
import { chatDocumentSchema, type ChatDocument, type ChatFileReference } from '@tulipfarm/conversations/rich-content';
import { PackageMessageText } from './package-reference';

export function RichMessage({
  content,
  file,
}: {
  content: ChatDocument;
  file: (reference: ChatFileReference) => ReactNode;
}) {
  const document = chatDocumentSchema.parse(content);
  return (
    <div className="space-y-3 text-base wrap-break-word">
      {document.doc.content.map((node, index) => (
        <Block key={index} node={node as JSONContent} file={file} />
      ))}
    </div>
  );
}

function Inline({ node, file }: { node: JSONContent; file: (reference: ChatFileReference) => ReactNode }) {
  if (node.type === 'hardBreak') return <br />;
  if (node.type === 'fileReference') return <>{file(node.attrs as ChatFileReference)}</>;
  let content: ReactNode = node.marks?.some(mark => mark.type === 'code' || mark.type === 'link') ? (
    (node.text ?? '')
  ) : (
    <PackageMessageText text={node.text ?? ''} />
  );
  for (const mark of node.marks ?? []) {
    if (mark.type === 'bold') content = <strong>{content}</strong>;
    else if (mark.type === 'italic') content = <em>{content}</em>;
    else if (mark.type === 'strike') content = <s>{content}</s>;
    else if (mark.type === 'code') content = <code className="rounded bg-muted px-1 font-mono text-sm">{content}</code>;
    else if (mark.type === 'link')
      content = (
        <a
          className="text-primary-text underline"
          href={String(mark.attrs?.href)}
          target="_blank"
          rel="noopener noreferrer"
        >
          {content}
        </a>
      );
  }
  return <>{content}</>;
}

function Inlines({
  nodes,
  file,
}: {
  nodes?: JSONContent[] | undefined;
  file: (reference: ChatFileReference) => ReactNode;
}) {
  return (
    <>
      {(nodes ?? []).map((node, index) => (
        <Fragment key={index}>
          <Inline node={node} file={file} />
        </Fragment>
      ))}
    </>
  );
}

function Block({ node, file }: { node: JSONContent; file: (reference: ChatFileReference) => ReactNode }) {
  if (node.type === 'paragraph')
    return (
      <p className="whitespace-pre-wrap">
        <Inlines nodes={node.content} file={file} />
      </p>
    );
  if (node.type === 'heading') {
    const children = <Inlines nodes={node.content} file={file} />;
    if (node.attrs?.level === 1) return <h1 className="text-xl font-medium">{children}</h1>;
    if (node.attrs?.level === 2) return <h2 className="text-lg font-medium">{children}</h2>;
    return <h3 className="text-base font-medium">{children}</h3>;
  }
  if (node.type === 'blockquote')
    return (
      <blockquote className="space-y-2 border-l-2 border-border pl-3">
        {node.content?.map((child, index) => (
          <Block key={index} node={child} file={file} />
        ))}
      </blockquote>
    );
  if (node.type === 'codeBlock')
    return (
      <pre className="overflow-x-auto rounded-lg bg-muted p-3">
        <code className="font-mono text-sm">{node.content?.map(child => child.text ?? '').join('')}</code>
      </pre>
    );
  if (node.type === 'bulletList')
    return (
      <ul className="list-disc space-y-1 pl-6">
        {node.content?.map((item, index) => (
          <ListItem key={index} item={item} file={file} />
        ))}
      </ul>
    );
  if (node.type === 'orderedList')
    return (
      <ol className="list-decimal space-y-1 pl-6" start={Number(node.attrs?.start ?? 1)}>
        {node.content?.map((item, index) => (
          <ListItem key={index} item={item} file={file} />
        ))}
      </ol>
    );
  return null;
}

function ListItem({ item, file }: { item: JSONContent; file: (reference: ChatFileReference) => ReactNode }) {
  return (
    <li className="space-y-1">
      {item.content?.map((child, index) => (
        <Block key={index} node={child} file={file} />
      ))}
    </li>
  );
}
