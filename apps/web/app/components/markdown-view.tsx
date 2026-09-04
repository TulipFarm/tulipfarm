import { useMemo } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "~/components/ui/link";
import { rehypeCallouts } from "~/lib/rehype-callouts";
import { rehypeCitations } from "~/lib/rehype-citations";
import { rehypeStreamWords, type StreamWordCounter } from "~/lib/rehype-stream-words";
import { rehypeTags } from "~/lib/rehype-tags";
import { mentionComponents } from "./chat/mention-chip";
import { rehypeMentions } from "./chat/mention-highlight";
import type { MentionEntry } from "./chat/use-mention-catalog";

const TAG_BASE = "/knowledge/tags/";
const REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [remarkGfm];
const NO_MENTIONS: MentionEntry[] = [];
const NO_CITATIONS: { ref: number; url: string }[] = [];

const wikiUrlTransform = (url: string) =>
  /^tf:(page|agent|resource)\//.test(url) ? url : defaultUrlTransform(url);

function makeAnchorRenderer(opts: { wikiLinks: boolean; citations: boolean }): Components["a"] {
  return ({ node: _n, children, href, className, ...p }) => {
    const target = typeof href === "string" ? href : "";
    const isCitation =
      opts.citations &&
      typeof className === "string" &&
      className.split(" ").includes("tf-citation");
    if (isCitation && target.startsWith("/")) {
      return (
        <Link
          to={target}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-brand no-underline hover:underline cursor-pointer"
          title={`Open cited source (${target}) in a new tab`}
        >
          {children}
        </Link>
      );
    }
    if (opts.wikiLinks && target.startsWith("/")) {
      const cls =
        typeof className === "string"
          ? className
          : "text-brand underline underline-offset-2 hover:opacity-80 cursor-pointer";
      return (
        <Link to={target} className={cls}>
          {children}
        </Link>
      );
    }
    if (opts.wikiLinks && target.startsWith("tf:")) {
      return (
        <span className="text-muted-foreground" title="link target not found">
          {children}
        </span>
      );
    }
    return (
      <a
        className="text-brand underline underline-offset-2 hover:opacity-80 cursor-pointer"
        target="_blank"
        rel="noreferrer"
        href={target}
        {...p}
      >
        {children}
      </a>
    );
  };
}

function calloutBorder(kind: string): string {
  return kind === "WARNING" || kind === "CAUTION" ? "border-destructive" : "border-primary";
}

/*
 * Renders markdown (AGENT.md / SKILL.md bodies) styled to the terminal aesthetic — everything
 * stays JetBrains Mono; hierarchy comes from weight, color, and 1px borders, never shadows.
 * Each renderer drops react-markdown's `node` prop so it is not spread onto the DOM element.
 */

const components: Components = {
  h1: ({ node: _n, children, ...p }) => (
    <h1 className="mt-6 mb-3 text-xl font-semibold first:mt-0" {...p}>
      {children}
    </h1>
  ),
  h2: ({ node: _n, children, ...p }) => (
    <h2 className="mt-6 mb-2 text-lg font-semibold first:mt-0" {...p}>
      {children}
    </h2>
  ),
  h3: ({ node: _n, children, ...p }) => (
    <h3 className="mt-4 mb-2 text-base font-semibold first:mt-0" {...p}>
      {children}
    </h3>
  ),
  p: ({ node: _n, children, ...p }) => (
    <p className="my-3 text-foreground" {...p}>
      {children}
    </p>
  ),
  a: ({ node: _n, children, ...p }) => (
    <a
      className="text-brand underline underline-offset-2 hover:opacity-80"
      target="_blank"
      rel="noreferrer"
      {...p}
    >
      {children}
    </a>
  ),
  ul: ({ node: _n, children, ...p }) => (
    <ul className="my-3 ml-5 list-disc space-y-1 marker:text-muted-foreground" {...p}>
      {children}
    </ul>
  ),
  ol: ({ node: _n, children, ...p }) => (
    <ol className="my-3 ml-5 list-decimal space-y-1 marker:text-muted-foreground" {...p}>
      {children}
    </ol>
  ),
  li: ({ node: _n, children, ...p }) => (
    <li className="leading-relaxed" {...p}>
      {children}
    </li>
  ),
  blockquote: ({ node, children, ...p }) => {
    const raw = node?.properties?.dataCallout;
    const kind = typeof raw === "string" ? raw : undefined;
    if (kind) {
      return (
        <div
          data-callout={kind}
          className={`my-3 rounded-sm border-l-2 ${calloutBorder(kind)} bg-muted/40 px-3 py-2 text-foreground`}
        >
          <p className="mb-1 text-xs font-medium capitalize text-muted-foreground">{kind}</p>
          <div className="[&>:first-child]:mt-0 [&>:last-child]:mb-0">{children}</div>
        </div>
      );
    }
    return (
      <blockquote className="my-3 border-l border-border pl-3 text-muted-foreground" {...p}>
        {children}
      </blockquote>
    );
  },
  code: ({ node: _n, children, className, ...p }) => {
    const isBlock = typeof className === "string" && className.includes("language-");
    if (isBlock) {
      return (
        <code className={className} {...p}>
          {children}
        </code>
      );
    }
    return (
      <code className="rounded-sm bg-muted px-1 py-0.5 text-[0.85em] text-foreground" {...p}>
        {children}
      </code>
    );
  },
  pre: ({ node: _n, children, ...p }) => (
    <pre
      className="my-3 overflow-x-auto rounded-sm border border-border bg-muted p-3 text-sm"
      {...p}
    >
      {children}
    </pre>
  ),
  table: ({ node: _n, children, ...p }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...p}>
        {children}
      </table>
    </div>
  ),
  th: ({ node: _n, children, ...p }) => (
    <th
      className="border border-border bg-muted px-2 py-1 text-left text-xs text-muted-foreground"
      {...p}
    >
      {children}
    </th>
  ),
  td: ({ node: _n, children, ...p }) => (
    <td className="border border-border px-2 py-1 align-top" {...p}>
      {children}
    </td>
  ),
  hr: ({ node: _n, ...p }) => <hr className="my-4 border-border" {...p} />,
};

export function MarkdownView({
  children,
  mentions,
  wikiLinks,
  citations,
  streamWords,
}: {
  children: string;
  mentions?: MentionEntry[];
  /** Knowledge-wiki mode: render internal `/…` hrefs as client links and `#tag` text as chip links. */
  wikiLinks?: boolean;
  citations?: { ref: number; url: string }[];
  /** While a Turn streams: blur-reveal words past `from`, and report this pass's count via `counter`. */
  streamWords?: { from: number; counter: StreamWordCounter };
}) {
  const list = mentions ?? NO_MENTIONS;
  const active = list.length > 0;
  const byPhrase = useMemo(() => new Map(list.map((m) => [m.phrase, m] as const)), [list]);
  const refs = useMemo(
    () => new Map((citations ?? NO_CITATIONS).map((c) => [c.ref, c.url] as const)),
    [citations]
  );
  const citationsOn = refs.size > 0;
  const anchor = useMemo(
    () => makeAnchorRenderer({ wikiLinks: Boolean(wikiLinks), citations: citationsOn }),
    [wikiLinks, citationsOn]
  );
  // Rebuilding these arrays/objects each render hands ReactMarkdown new plugin and component
  // identities every time, which forces a full re-parse — once per token while a turn streams.
  const rehypePlugins = useMemo<Options["rehypePlugins"]>(() => {
    const plugins: NonNullable<Options["rehypePlugins"]> = [rehypeCallouts];
    if (active) plugins.push([rehypeMentions, { phrases: list.map((m) => m.phrase) }]);
    if (wikiLinks) plugins.push([rehypeTags, { tagBase: TAG_BASE }]);
    if (citationsOn) plugins.push([rehypeCitations, { refs }]);
    if (streamWords) plugins.push([rehypeStreamWords, streamWords]);
    return plugins;
  }, [active, list, wikiLinks, citationsOn, refs, streamWords]);
  const resolvedComponents = useMemo<Components>(() => {
    let resolved: Components = components;
    if (active) resolved = { ...resolved, ...mentionComponents(byPhrase) };
    if (wikiLinks || citationsOn) resolved = { ...resolved, a: anchor };
    return resolved;
  }, [active, byPhrase, wikiLinks, citationsOn, anchor]);
  return (
    /* Every caller — transcript, knowledge page, skill body, agent body, setup guide — is prose
       someone reads at length, so this is pinned to the reading size rather than the 13px the
       type scale gives chrome. */
    <div className="text-base">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={rehypePlugins}
        components={resolvedComponents}
        urlTransform={wikiLinks ? wikiUrlTransform : undefined}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
