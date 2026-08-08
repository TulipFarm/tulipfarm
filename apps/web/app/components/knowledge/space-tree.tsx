import { Link, useParams } from "@remix-run/react";
import { ChevronRight, FileText, Folder, Library, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type KnowledgeSpace,
  listAllPages,
  listSpaces,
  navigateSpace,
  type SpacePageRef,
} from "~/lib/knowledge-api";
import { listingToNodes, type PageNode } from "~/lib/okf-listing";
import { buildPageResolver, type PageResolver, pageHref } from "~/lib/page-href";
import { cn } from "~/lib/utils";
import { SidebarSearch } from "./sidebar-search";

/*
 * Unified knowledge tree (the wiki rail). A forest of spaces; each expands lazily into its
 * pages via the `navigate` endpoint. A page that has both a body and children renders as ONE node that
 * is clickable (opens the page) AND expandable (reveals sub-pages) — the merge rule in okf-listing.
 * The active space/page (from the route splat) is highlighted and auto-expanded. The tree re-reads on
 * the `okf:space-changed` window event a write dispatches. cursor-pointer on every interactive node.
 */

const enc = encodeURIComponent;

export function KnowledgeTree() {
  const params = useParams();
  const [spaces, setSpaces] = useState<KnowledgeSpace[] | null>(null);
  const [pages, setPages] = useState<SpacePageRef[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [page, all] = await Promise.all([listSpaces(), listAllPages()]);
      setSpaces(page.items);
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
    window.addEventListener("okf:space-changed", onChanged);
    return () => window.removeEventListener("okf:space-changed", onChanged);
  }, [load]);

  // `listAllPages` doubles as the path↔id resolver for page hrefs and the active-highlight: page
  // routes carry the page UUID (`params.pageId`), not (spaceId, path), so resolve it back to its
  // page. The space-home / new-page routes still carry `params.id`.
  const resolver = useMemo(() => buildPageResolver(pages), [pages]);
  const activeRef = params.pageId ? resolver.byId(params.pageId) : null;
  const activeSpaceId = activeRef?.spaceId ?? params.id;
  const activePath = activeRef?.path ?? null;

  return (
    <nav aria-label="Knowledge" className="flex min-h-0 flex-1 flex-col text-sm">
      <SidebarSearch />
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-3">
        {error ? (
          <p className="px-2 py-1 text-xs text-destructive">
            error: {error}{" "}
            <button type="button" onClick={() => void load()} className="cursor-pointer underline">
              retry
            </button>
          </p>
        ) : spaces === null ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">loading…</p>
        ) : spaces.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            No spaces yet.{" "}
            <Link to="/knowledge/spaces/new" className="cursor-pointer text-primary underline">
              Create one
            </Link>
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {spaces.map((b) => (
              <SpaceNode
                key={b.id}
                space={b}
                isActiveSpace={b.id === activeSpaceId}
                activePath={b.id === activeSpaceId ? activePath : null}
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
  space,
  isActiveSpace,
  activePath,
  resolver,
}: {
  space: KnowledgeSpace;
  isActiveSpace: boolean;
  activePath: string | null;
  resolver: PageResolver;
}) {
  const [open, setOpen] = useState(isActiveSpace);
  const base = `/knowledge/spaces/${enc(space.id)}`;
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
          title={space.name}
        >
          {space.name}
        </Link>
        <Link
          to={`${base}/pages/new`}
          title="New page"
          aria-label={`New page in ${space.name}`}
          className="cursor-pointer rounded-sm p-1 text-muted-foreground opacity-0 transition hover:text-primary group-hover:opacity-100"
        >
          <Plus className="size-3" aria-hidden />
        </Link>
      </div>
      {open ? (
        <Dir spaceId={space.id} dirPath="" depth={1} activePath={activePath} resolver={resolver} />
      ) : null}
    </li>
  );
}

function Dir({
  spaceId,
  dirPath,
  depth,
  activePath,
  resolver,
}: {
  spaceId: string;
  dirPath: string;
  depth: number;
  activePath: string | null;
  resolver: PageResolver;
}) {
  const [nodes, setNodes] = useState<PageNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { listing } = await navigateSpace(spaceId, dirPath);
      setNodes(listingToNodes(dirPath, listing));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, [spaceId, dirPath]);

  useEffect(() => {
    void load();
  }, [load]);

  // An open directory must re-read after a write elsewhere in the space, else new/deleted pages
  // stay stale until it is collapsed and re-expanded.
  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener("okf:space-changed", onChanged);
    return () => window.removeEventListener("okf:space-changed", onChanged);
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
          spaceId={spaceId}
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
  spaceId,
  node,
  depth,
  activePath,
  resolver,
}: {
  spaceId: string;
  node: PageNode;
  depth: number;
  activePath: string | null;
  resolver: PageResolver;
}) {
  const [open, setOpen] = useState(() => !!activePath && activePath.startsWith(`${node.path}/`));
  const base = `/knowledge/spaces/${enc(spaceId)}`;
  const isActive = activePath === node.path;
  const pad = { paddingLeft: `${depth * 0.75 + 0.25}rem` };
  // A page with a body links to its stable page UUID route (resolved from its path).
  const ref = resolver.bySpaceIdPath(spaceId, node.path);
  const to = node.hasBody && ref ? pageHref(ref.pageId, node.path) : null;

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
          to={`${base}/pages/new?parent=${enc(node.path)}`}
          title="New sub-page"
          aria-label={`New page under ${node.label}`}
          className="cursor-pointer rounded-sm p-1 text-muted-foreground opacity-0 transition hover:text-primary group-hover:opacity-100"
        >
          <Plus className="size-3" aria-hidden />
        </Link>
      </div>
      {node.hasChildren && open ? (
        <Dir
          spaceId={spaceId}
          dirPath={node.path}
          depth={depth + 1}
          activePath={activePath}
          resolver={resolver}
        />
      ) : null}
    </li>
  );
}
