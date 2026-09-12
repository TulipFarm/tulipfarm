import { type MetaFunction, Outlet, useLocation, useParams } from "@remix-run/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BookText, Plus } from "~/components/icons";
import { CommandPalette, OPEN_SEARCH_EVENT } from "~/components/knowledge/command-palette";
import { KnowledgeTree } from "~/components/knowledge/space-tree";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { Modal } from "~/components/ui/modal";
import { Tooltip } from "~/components/ui/tooltip";

export const meta: MetaFunction = () => [{ title: "Knowledge · tulipfarm" }];

/*
 * Knowledge owns its own tree. The app sidebar is one flat list of destinations with no second
 * layer to swap in, so the space/page hierarchy lives inside the section it belongs to — which is
 * also the only place it was ever useful.
 */
export default function KnowledgeLayout() {
  // `params.id` is the active space on space routes (home/new/graph); page-reader routes carry
  // `pageId` instead, so the scope toggle defaults to all-spaces there.
  const params = useParams();
  const location = useLocation();
  const [desktop, setDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches
  );
  const [browseLocation, setBrowseLocation] = useState<string | null>(null);
  const browseTrigger = useRef<HTMLButtonElement>(null);
  const restoreBrowseFocus = useRef(false);
  const searchReturnLocation = useRef<string | null>(null);
  const browseOpen = !desktop && browseLocation === location.key;
  const closeBrowse = useCallback(() => {
    restoreBrowseFocus.current = true;
    setBrowseLocation(null);
  }, []);
  const onSearchOpenChange = useCallback(
    (open: boolean) => {
      if (open || searchReturnLocation.current === null) return;
      if (searchReturnLocation.current === location.key) browseTrigger.current?.focus();
      searchReturnLocation.current = null;
    },
    [location.key]
  );

  useEffect(() => {
    if (!browseOpen && restoreBrowseFocus.current) {
      restoreBrowseFocus.current = false;
      browseTrigger.current?.focus();
    }
  }, [browseOpen]);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const onChange = (event: MediaQueryListEvent) => {
      setDesktop(event.matches);
      setBrowseLocation(null);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (browseLocation !== location.key) setBrowseLocation(null);
  }, [browseLocation, location.key]);

  useEffect(() => {
    // Search is shared and portalled outside the native dialog, so release its inert background first.
    const releaseForSearch = () => {
      if (browseOpen) searchReturnLocation.current = location.key;
      setBrowseLocation(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (browseOpen && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopPropagation();
        window.dispatchEvent(new Event(OPEN_SEARCH_EVENT));
      }
    };
    window.addEventListener(OPEN_SEARCH_EVENT, releaseForSearch);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener(OPEN_SEARCH_EVENT, releaseForSearch);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [browseOpen, location.key]);

  const tree = (
    <>
      <div className="flex min-h-10 shrink-0 items-center gap-1 border-b border-border px-3 pointer-coarse:min-h-12">
        <h2 className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          Spaces
        </h2>
        <Tooltip content="New space">
          <Button asChild variant="ghost" size="sm">
            <Link to="/knowledge/spaces/new" aria-label="New space">
              <Plus className="size-4" aria-hidden />
            </Link>
          </Button>
        </Tooltip>
      </div>
      <KnowledgeTree />
    </>
  );
  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      {desktop ? (
        <div className="flex w-60 shrink-0 flex-col border-e border-border bg-sidebar">{tree}</div>
      ) : (
        <div className="shrink-0 border-b border-border px-4 py-2">
          <Button
            ref={browseTrigger}
            variant="outline"
            size="sm"
            aria-haspopup="dialog"
            aria-expanded={browseOpen}
            onClick={() => setBrowseLocation(location.key)}
          >
            <BookText className="size-4" aria-hidden />
            Browse pages
          </Button>
        </div>
      )}
      <div className="min-h-0 min-w-0 flex-1">
        <Outlet />
      </div>
      {browseOpen ? (
        <Modal
          open
          onClose={closeBrowse}
          title="Browse pages"
          className="h-[85dvh] w-[calc(100%_-_1.5rem)] max-w-md overscroll-contain [&>div:first-child_button]:min-h-11 [&>div:first-child_button]:min-w-11"
          bodyClassName="flex min-h-0 flex-1 flex-col p-0"
        >
          {tree}
        </Modal>
      ) : null}
      <CommandPalette spaceId={params.id} onOpenChange={onSearchOpenChange} />
    </div>
  );
}
