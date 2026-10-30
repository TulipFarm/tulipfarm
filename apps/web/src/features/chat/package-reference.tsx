import { Node } from '@tiptap/core';
import type { ReactNode } from 'react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { isHistoryTransaction } from '@tiptap/pm/history';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { Link } from '@tanstack/react-router';
import { marketplacePackage } from '@tulipfarm/config/package-links';
import { Badge } from '@tulipfarm/sprout/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@tulipfarm/sprout/tooltip';
import { ArrowUpRight } from 'reicon-react/icons/ArrowUpRight';
import { useFeatureRead } from '@/lib/query';
import { workspaceRoute } from '@/router';
import { loadPublicPackages } from '@/features/packages/public-catalog';

const packageReferenceKey = new PluginKey('packageReference');

function PackageReference({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper as="span" contentEditable={false}>
      <PackagePill url={String(node.attrs.url)} />
    </NodeViewWrapper>
  );
}

export function PackageMessageText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(/https:\/\/[^\s<>"`]+/gi)) {
    const url = match[0].replace(/[)\]}>.,;!?]+$/, '');
    if (!marketplacePackage(url)) continue;
    parts.push(text.slice(offset, match.index), <PackagePill key={match.index} url={url} />);
    offset = match.index + url.length;
  }
  parts.push(text.slice(offset));
  return <>{parts}</>;
}

function PackagePill({ url }: { url: string }) {
  const workspaceSlug = workspaceRoute.useParams({ shouldThrow: false })?.workspaceSlug;
  const link = marketplacePackage(url);
  const read = useFeatureRead({
    key: ['public-packages'],
    load: loadPublicPackages,
    staleTime: 5 * 60_000,
    enabled: !!link,
  });
  const entry =
    read.state.kind === 'ready'
      ? read.state.data.find(item => item.name === link?.name && item.version === link?.version)
      : undefined;
  const title =
    entry?.title ??
    link?.name
      .split('-')
      .map(word => word[0]!.toUpperCase() + word.slice(1))
      .join(' ') ??
    'Package';
  const destination =
    link && workspaceSlug ? (
      <Link
        to="/$workspaceSlug/packages/catalog/$packageName/$packageVersion"
        params={{ workspaceSlug, packageName: link.name, packageVersion: link.version }}
        target="_blank"
        rel="noopener noreferrer"
        title=""
        aria-label={`Open ${title}, version ${link.version}, in a new tab`}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()}
      />
    ) : undefined;
  const pill = (
    <Badge variant="secondary" render={destination}>
      <img src="/favicon.svg" alt="" className="size-3.5 shrink-0 scheme-light dark:scheme-dark" />
      <span className="max-w-60 truncate">Package: {title}</span>
    </Badge>
  );
  return (
    <span title={url}>
      {destination ? (
        <Tooltip>
          <TooltipTrigger render={pill} />
          <TooltipContent>
            <span className="flex items-center gap-1">
              Open package in new tab <ArrowUpRight size={14} aria-hidden="true" />
            </span>
          </TooltipContent>
        </Tooltip>
      ) : (
        pill
      )}
    </span>
  );
}

export const packageReferenceExtension = Node.create({
  name: 'packageReference',
  inline: true,
  group: 'inline',
  atom: true,
  marks: '',
  addAttributes() {
    return { url: { default: '' } };
  },
  parseHTML() {
    return [
      {
        tag: 'span[data-package-url]',
        getAttrs: element => {
          const url = element.getAttribute('data-package-url') ?? '';
          return marketplacePackage(url) ? { url } : false;
        },
      },
    ];
  },
  renderHTML({ node }) {
    return ['span', { 'data-package-url': node.attrs.url }, node.attrs.url];
  },
  renderText({ node }) {
    return String(node.attrs.url);
  },
  addNodeView() {
    return ReactNodeViewRenderer(PackageReference);
  },
  onCreate() {
    this.editor.view.dispatch(this.editor.state.tr.setMeta(packageReferenceKey, true));
  },
  onBlur() {
    if (!this.editor.isDestroyed) this.editor.view.dispatch(this.editor.state.tr.setMeta(packageReferenceKey, true));
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: packageReferenceKey,
        appendTransaction(transactions, _previous, state) {
          if (transactions.some(isHistoryTransaction)) return null;
          const complete = transactions.some(
            transaction =>
              transaction.getMeta(packageReferenceKey) ||
              transaction.getMeta('paste') ||
              transaction.getMeta('uiEvent') === 'paste',
          );
          if (!complete && !transactions.some(transaction => transaction.docChanged)) return null;
          const matches: { from: number; to: number; url: string }[] = [];
          state.doc.descendants((node, pos) => {
            if (node.type.spec.code) return false;
            if (!node.isText || node.marks.some(mark => mark.type.spec.code)) return;
            for (const match of node.text!.matchAll(/https:\/\/[^\s<>"`]+/gi)) {
              const url = match[0].replace(/[)\]}>.,;!?]+$/, '');
              if (!marketplacePackage(url)) continue;
              const from = pos + match.index;
              const to = from + url.length;
              // Wait for a delimiter, paste, or blur instead of replacing a URL mid-keystroke.
              if (!complete && state.selection.empty && state.selection.from >= from && state.selection.from <= to)
                continue;
              matches.push({ from, to, url });
            }
          });
          if (!matches.length) return null;
          const transaction = state.tr;
          for (const { from, to, url } of matches.reverse())
            transaction.replaceWith(from, to, state.schema.nodes.packageReference!.create({ url }));
          return transaction;
        },
      }),
    ];
  },
});
