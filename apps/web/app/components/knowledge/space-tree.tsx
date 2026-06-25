import { Link, useParams } from "@remix-run/react";
import { ChevronRight, FileText, Folder, Library, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { buildConceptResolver, type ConceptResolver, conceptHref } from "~/lib/concept-href";
import {
  type BundlePageRef,
  type KnowledgeBundle,
  listAllPages,
  listBundles,
  navigateBundle,
} from "~/lib/knowledge-api";
import { listingToNodes, type PageNode } from "~/lib/okf-listing";
import { cn } from "~/lib/utils";

/*
 * Unified knowledge tree (the wiki rail). A forest of spaces (bundles); each expands lazily into its
 * pages via the `navigate` endpoint. A page that has both a body and children renders as ONE node that
 * is clickable (opens the page) AND expandable (reveals sub-pages) — the merge rule in okf-listing.
 * The active space/page (from the route splat) is highlighted and auto-expanded. The tree re-reads on
 * the `okf:bundle-changed` window event a write dispatches. cursor-pointer on every interactive node.
 */

const enc = encodeURIComponent;

export function KnowledgeTree() {
  const params = useParams();
  const [bundles, setBundles] = useState<KnowledgeBundle[] | null>(null);
  const [pages, setPages] = useState<BundlePageRef[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [page, all] = await Promise.all([listBundles(), listAllPages()]);
      setBundles(page.items);
      setPages(all.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener("okf:bundle-changed", onChanged);
    return () => window.removeEventListener("okf:bundle-changed", onChanged);
  }, [load]);

  // `listAllPages` doubles as the path↔id resolver for page hrefs and the active-highlight: concept
  // routes carry the doc UUID (`params.conceptId`), not (bundleId, path), so resolve it back to its
  // page. The bundle-home / new-page routes still carry `params.id`.
  const resolver = useMemo(() => buildConceptResolver(pages), [pages]);
  const activeRef = params.conceptId ? resolver.byId(params.conceptId) : null;
  const activeBundleId = activeRef?.bundleId ?? params.id;
  const activePath = activeRef?.path ?? null;

  return (
    <nav aria-label="Knowledge" className="flex min-h-0 flex-1 flex-col text-sm">
      <div className="flex shrink-0 items-center justify-between px-3 py-2">
        <span className="text-[0.625rem] font-medium uppercase tracking-[0.2em] text-muted-foreground">
          Knowledge
        </span>
        <Link
          to="/knowledge/bundles/new"
          title="New space"
          aria-label="New space"
          className="cursor-pointer rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-primary"
        >
          <Plus className="size-3.5" aria-hidden />
        </Link>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-3">
        {error ? (
          <p className="px-2 py-1 text-xs text-destructive">
            error: {error}{" "}
            <button type="button" onClick={() => void load()} className="cursor-pointer underline">
              retry
            </button>
          </p>
        ) : bundles === null ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">loading…</p>
        ) : bundles.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            No spaces yet.{" "}
            <Link to="/knowledge/bundles/new" className="cursor-pointer text-primary underline">
              Create one
            </Link>
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {bundles.map((b) => (
              <SpaceNode
                key={b.id}
                bundle={b}
                isActiveSpace={b.id === activeBundleId}
                activePath={b.id === activeBundleId ? activePath : null}
                resolver={resolver}
              />
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}

function SpaceNode({
  bundle,
  isActiveSpace,
  activePath,
  resolver,
}: {
  bundle: KnowledgeBundle;
  isActiveSpace: boolean;
  activePath: string | null;
  resolver: ConceptResolver;
}) {
  const [open, setOpen] = useState(isActiveSpace);
  const base = `/knowledge/bundles/${enc(bundle.id)}`;
  return (
    <li>
      <div className="group flex items-center gap-1 rounded-sm pr-1 hover:bg-accent">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Collapse" : "Expand"}
          className="cursor-pointer rounded-sm p-1 text-muted-foreground"
        >
          <ChevronRight
            className={cn("size-3.5 transition-transform", open && "rotate-90")}
            aria-hidden
          />
        </button>
        <Library className="size-3.5 shrink-0 text-primary" aria-hidden />
        <Link
          to={base}
          className={cn(
            "min-w-0 flex-1 cursor-pointer truncate py-1 font-medium",
            isActiveSpace && !activePath ? "text-primary" : "text-foreground"
          )}
          title={bundle.name}
        >
          {bundle.name}
        </Link>
        <Link
          to={`${base}/concepts/new`}
          title="New page"
          aria-label={`New page in ${bundle.name}`}
          className="cursor-pointer rounded-sm p-1 text-muted-foreground opacity-0 transition hover:text-primary group-hover:opacity-100"
        >
          <Plus className="size-3" aria-hidden />
        </Link>
      </div>
      {open ? (
        <Dir
          bundleId={bundle.id}
          dirPath=""
          depth={1}
          activePath={activePath}
          resolver={resolver}
        />
      ) : null}
    </li>
  );
}

function Dir({
  bundleId,
  dirPath,
  depth,
  activePath,
  resolver,
}: {
  bundleId: string;
  dirPath: string;
  depth: number;
  activePath: string | null;
  resolver: ConceptResolver;
}) {
  const [nodes, setNodes] = useState<PageNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { listing } = await navigateBundle(bundleId, dirPath);
      setNodes(listingToNodes(dirPath, listing));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, [bundleId, dirPath]);

  useEffect(() => {
    void load();
  }, [load]);

  // An open directory must re-read after a write elsewhere in the space, else new/deleted pages
  // stay stale until it is collapsed and re-expanded.
  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener("okf:bundle-changed", onChanged);
    return () => window.removeEventListener("okf:bundle-changed", onChanged);
  }, [load]);

  const pad = { paddingLeft: `${depth * 0.75 + 0.25}rem` };

  if (loading && nodes === null)
    return (
      <p className="px-2 py-1 text-xs text-muted-foreground" style={pad}>
        loading…
      </p>
    );
  if (error)
    return (
      <p className="px-2 py-1 text-xs text-destructive" style={pad}>
        error{" "}
        <button type="button" onClick={() => void load()} className="cursor-pointer underline">
          retry
        </button>
      </p>
    );
  if (nodes && nodes.length === 0)
    return (
      <p className="px-2 py-1 text-xs text-muted-foreground" style={pad}>
        empty
      </p>
    );

  return (
    <ul className="flex flex-col gap-0.5">
      {(nodes ?? []).map((node) => (
        <PageRow
          key={node.path}
          bundleId={bundleId}
          node={node}
          depth={depth}
          activePath={activePath}
          resolver={resolver}
        />
      ))}
    </ul>
  );
}

function PageRow({
  bundleId,
  node,
  depth,
  activePath,
  resolver,
}: {
  bundleId: string;
  node: PageNode;
  depth: number;
  activePath: string | null;
  resolver: ConceptResolver;
}) {
  const [open, setOpen] = useState(() => !!activePath && activePath.startsWith(`${node.path}/`));
  const base = `/knowledge/bundles/${enc(bundleId)}`;
  const isActive = activePath === node.path;
  const pad = { paddingLeft: `${depth * 0.75 + 0.25}rem` };
  // A page with a body links to its stable concept UUID route (resolved from its path).
  const ref = resolver.byBundleIdPath(bundleId, node.path);
  const to = node.hasBody && ref ? conceptHref(ref.documentId, node.path) : null;

  return (
    <li>
      <div
        className={cn(
          "group flex items-center gap-1 rounded-sm pr-1",
          isActive ? "bg-sidebar-accent" : "hover:bg-accent"
        )}
        style={pad}
      >
        {node.hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? "Collapse" : "Expand"}
            className="cursor-pointer rounded-sm p-0.5 text-muted-foreground"
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", open && "rotate-90")}
              aria-hidden
            />
          </button>
        ) : (
          <span className="w-[1.375rem] shrink-0" aria-hidden />
        )}
        {node.hasChildren && !node.hasBody ? (
          <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        {to ? (
          <Link
            to={to}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "min-w-0 flex-1 cursor-pointer truncate py-1",
              isActive ? "font-medium text-sidebar-primary" : "text-foreground"
            )}
            title={node.label}
          >
            {node.label}
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="min-w-0 flex-1 cursor-pointer truncate py-1 text-left font-medium text-foreground"
            title={node.label}
          >
            {node.label}
          </button>
        )}
        <Link
          to={`${base}/concepts/new?parent=${enc(node.path)}`}
          title="New sub-page"
          aria-label={`New page under ${node.label}`}
          className="cursor-pointer rounded-sm p-1 text-muted-foreground opacity-0 transition hover:text-primary group-hover:opacity-100"
        >
          <Plus className="size-3" aria-hidden />
        </Link>
      </div>
      {node.hasChildren && open ? (
        <Dir
          bundleId={bundleId}
          dirPath={node.path}
          depth={depth + 1}
          activePath={activePath}
          resolver={resolver}
        />
      ) : null}
    </li>
  );
}
