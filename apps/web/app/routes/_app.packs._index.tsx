import type { MetaFunction } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Box, Search, Upload, X } from "~/components/icons";
import { PackCard } from "~/components/packs/pack-card";
import { PACK_CATEGORY_STYLE, PackCategoryIcon } from "~/components/packs/pack-category";
import { PackPreviewPanel } from "~/components/packs/pack-preview";
import { PageShell } from "~/components/page-shell";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import { ApiError } from "~/lib/api";
import {
  listPacks,
  PACK_CATEGORIES,
  type PackPreview,
  type PackSummary,
  previewPack,
} from "~/lib/packs";
import { cn } from "~/lib/utils";

export const meta: MetaFunction = () => [{ title: "Packs · tulipfarm" }];

export default function PacksCatalog() {
  const [packs, setPacks] = useState<PackSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [selected, setSelected] = useState<PackSummary | null>(null);
  const [preview, setPreview] = useState<PackPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewRetry, setPreviewRetry] = useState(0);
  const previewRegion = useRef<HTMLElement>(null);
  const previewTrigger = useRef<HTMLButtonElement | null>(null);

  function closePreview() {
    setSelected(null);
    setPreview(null);
    requestAnimationFrame(() => previewTrigger.current?.focus());
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload retries a failed catalog request
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void listPacks().then(
      (items) => {
        if (!cancelled) {
          setPacks(items);
          setLoading(false);
        }
      },
      (err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof ApiError && err.status === 403
              ? "You do not have permission to browse Packs."
              : "Could not load Packs. Try again."
          );
          setLoading(false);
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [reload]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: previewRetry retries the selected source
  useEffect(() => {
    if (!selected) return;
    previewRegion.current?.focus();
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    void previewPack({ url: selected.url }).then(
      (result) => {
        if (!cancelled) {
          setPreview(result);
          setPreviewLoading(false);
        }
      },
      () => {
        if (!cancelled) {
          setPreviewError("Could not preview this Pack. Its source may be unavailable or invalid.");
          setPreviewLoading(false);
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [selected, previewRetry]);

  const needle = query.trim().toLowerCase();
  const filtered = packs.filter(
    (pack) =>
      (category === "All" || pack.category === category) &&
      `${pack.title} ${pack.name} ${pack.description}`.toLowerCase().includes(needle)
  );

  return (
    <PageShell
      title="Packs"
      actions={
        <Button asChild variant="outline">
          <Link to="/packs/import">
            <Upload />
            Import Pack
          </Link>
        </Button>
      }
    >
      <div hidden={selected !== null}>
        <div className="space-y-6">
          <section className="flex flex-wrap items-center justify-between gap-5 rounded-xl bg-card px-5 py-6 sm:px-6">
            <div className="max-w-xl space-y-2">
              <h2 className="text-2xl font-semibold tracking-tight">
                A head start for your business.
              </h2>
              <p className="max-w-lg text-sm leading-relaxed text-muted-foreground">
                Ready-made starting points for your team. Your agent adapts the details; you decide
                what gets installed.
              </p>
            </div>
            <ol
              aria-label="Installation process"
              className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground"
            >
              <li>Preview a Pack</li>
              <li className="flex items-center gap-3">
                <ArrowRight className="size-3" />
                Adapt in Chat
              </li>
              <li className="flex items-center gap-3">
                <ArrowRight className="size-3" />
                Review &amp; confirm
              </li>
            </ol>
          </section>
          <fieldset
            aria-label="Pack categories"
            className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6"
          >
            {PACK_CATEGORIES.map((item) => {
              const style = PACK_CATEGORY_STYLE[item];
              return (
                <button
                  type="button"
                  key={item}
                  aria-pressed={category === item}
                  onClick={() => setCategory(category === item ? "All" : item)}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent",
                    category === item ? "border-border-strong bg-accent" : "border-border"
                  )}
                >
                  <span className={cn("rounded-md p-2", style.background, style.ink)}>
                    <PackCategoryIcon category={item} className="size-4" />
                  </span>
                  <span className="min-w-0 space-y-0.5">
                    <span className="block text-xs font-medium">{item}</span>
                    {!loading && !error ? (
                      <span
                        aria-hidden
                        className="block text-xs tabular-nums text-muted-foreground"
                      >
                        {packs.filter((pack) => pack.category === item).length} Packs
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </fieldset>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <Button
                variant={category === "All" ? "secondary" : "ghost"}
                aria-pressed={category === "All"}
                aria-label="All"
                onClick={() => setCategory("All")}
              >
                <Box />
                All Packs
              </Button>
              {!loading && !error ? (
                <p className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
                  {filtered.length} {filtered.length === 1 ? "Pack" : "Packs"}
                  {category !== "All" ? ` in ${category}` : ""}
                </p>
              ) : null}
            </div>
            <div className="relative w-full sm:max-w-xs">
              <label htmlFor="pack-search" className="sr-only">
                Search Packs
              </label>
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="pack-search"
                placeholder="Search by name or use case"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-8 pr-8"
              />
              {query ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery("")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
            </div>
          </div>
          {loading ? (
            <div role="status">
              <span className="sr-only">Loading Packs…</span>
              <div aria-hidden className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {[0, 1, 2, 3, 4, 5].map((item) => (
                  <div
                    key={item}
                    className="overflow-hidden rounded-xl border motion-safe:animate-pulse"
                  >
                    <div className="h-28 bg-muted" />
                    <div className="space-y-3 p-4">
                      <div className="h-3 w-1/4 rounded bg-muted" />
                      <div className="h-4 w-3/4 rounded bg-muted" />
                      <div className="h-3 w-full rounded bg-muted" />
                      <div className="h-3 w-2/3 rounded bg-muted" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : error ? (
            <div role="alert" className="space-y-3 rounded-xl border p-6 text-sm">
              <p>{error}</p>
              <Button variant="outline" onClick={() => setReload((value) => value + 1)}>
                Try again
              </Button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-5 py-12 text-center">
              <span className="rounded-xl bg-muted p-3 text-muted-foreground">
                <Search className="size-6" />
              </span>
              <h2 className="text-base font-medium">
                {packs.length === 0 ? "Your next starting point" : "Try a different search"}
              </h2>
              <p className="max-w-sm text-sm text-muted-foreground">
                {packs.length === 0
                  ? "No Packs are available yet. You can still import one from a trusted source."
                  : "No Packs match your search or category."}
              </p>
              {packs.length > 0 ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setQuery("");
                    setCategory("All");
                  }}
                >
                  Clear filters
                </Button>
              ) : null}
            </div>
          ) : (
            <ul aria-label="Available Packs" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filtered.map((pack) => (
                <li key={pack.url} className="min-w-0">
                  <PackCard
                    pack={pack}
                    onPreview={(button) => {
                      previewTrigger.current = button;
                      setPreview(null);
                      setPreviewError(null);
                      setPreviewLoading(true);
                      setSelected(pack);
                      setPreviewRetry((value) => value + 1);
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {selected ? (
        <section
          ref={previewRegion}
          tabIndex={-1}
          aria-label={`Preview installation of ${selected.title}`}
          className="space-y-5 outline-none"
        >
          <Button variant="ghost" size="sm" onClick={closePreview}>
            <ArrowLeft />
            Back to Packs
          </Button>
          {previewLoading ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading Pack preview…
            </p>
          ) : null}
          {previewError ? (
            <div role="alert" className="space-y-2 text-sm">
              <p>{previewError}</p>
              <Button variant="outline" onClick={() => setPreviewRetry((value) => value + 1)}>
                Retry preview
              </Button>
            </div>
          ) : null}
          {preview ? (
            <PackPreviewPanel
              key={preview.sha256}
              preview={preview}
              source={{ url: selected.url }}
            />
          ) : null}
        </section>
      ) : null}
    </PageShell>
  );
}
