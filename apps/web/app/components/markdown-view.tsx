import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/*
 * Renders markdown (AGENT.md / SKILL.md bodies) styled to the terminal aesthetic — everything stays
 * JetBrains Mono; hierarchy comes from weight, color, and 1px borders, never shadows. GFM enabled for
 * tables/strikethrough/task-lists. Links open in a new tab (skill/agent bodies may reference sources).
 * Each renderer drops react-markdown's `node` prop so it is not spread onto the DOM element.
 */

const components: Components = {
  h1: ({ node: _n, children, ...p }) => (
    <h1 className="mt-6 mb-3 text-lg font-bold tracking-tight first:mt-0" {...p}>
      {children}
    </h1>
  ),
  h2: ({ node: _n, children, ...p }) => (
    <h2 className="mt-6 mb-2 text-base font-bold tracking-tight first:mt-0" {...p}>
      {children}
    </h2>
  ),
  h3: ({ node: _n, children, ...p }) => (
    <h3 className="mt-4 mb-2 font-medium tracking-tight first:mt-0" {...p}>
      {children}
    </h3>
  ),
  p: ({ node: _n, children, ...p }) => (
    <p className="my-3 leading-relaxed text-foreground" {...p}>
      {children}
    </p>
  ),
  a: ({ node: _n, children, ...p }) => (
    <a
      className="text-primary underline underline-offset-2 hover:opacity-80"
      target="_blank"
      rel="noreferrer"
      {...p}
    >
      {children}
    </a>
  ),
  ul: ({ node: _n, children, ...p }) => (
    <ul className="my-3 ml-5 list-disc space-y-1 marker:text-primary" {...p}>
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
  blockquote: ({ node: _n, children, ...p }) => (
    <blockquote className="my-3 border-l border-border pl-3 text-muted-foreground" {...p}>
      {children}
    </blockquote>
  ),
  code: ({ node: _n, children, className, ...p }) => {
    // Inline code (no language class) vs. fenced block (rendered inside <pre>).
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
      className="border border-border bg-muted px-2 py-1 text-left text-xs uppercase tracking-[0.1em] text-muted-foreground"
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

export function MarkdownView({ children }: { children: string }) {
  return (
    <div className="text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
