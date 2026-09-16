import type { MetaFunction } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
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
  const previewRegion = useRef<HTMLDivElement>(null);

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
          <Link to="/packs/import">Import Pack</Link>
        </Button>
      }
    >
      <p className="max-w-2xl text-sm text-muted-foreground">
        Start with a Pack of Resource types, Skills, Agents, Surfaces and Routines. Preview what it
        includes, then ask the agent to adapt a plan to your business before you confirm changes.
      </p>
      <Input
        aria-label="Search Packs"
        placeholder="Search Packs…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="max-w-sm"
      />
      <fieldset aria-label="Pack categories" className="flex flex-wrap gap-1.5">
        {["All", ...PACK_CATEGORIES].map((item) => (
          <Button
            key={item}
            size="sm"
            variant={category === item ? "default" : "outline"}
            aria-pressed={category === item}
            onClick={() => setCategory(item)}
          >
            {item}
          </Button>
        ))}
      </fieldset>
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading Packs…
        </p>
      ) : error ? (
        <div role="alert" className="space-y-2 text-sm">
          <p>{error}</p>
          <Button variant="outline" onClick={() => setReload((value) => value + 1)}>
            Try again
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {packs.length === 0
            ? "No Packs are available yet. You can still import one from a trusted source."
            : "No Packs match your search or category."}
        </p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((pack) => (
            <li key={pack.url} className="flex flex-col gap-3 rounded-lg border p-4">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  {pack.category} · Version {pack.version}
                </p>
                <h2 className="text-sm font-semibold">{pack.title}</h2>
                <p className="text-sm text-muted-foreground">{pack.description}</p>
              </div>
              <Button
                variant="outline"
                className="mt-auto self-start"
                aria-label={`Preview installation of ${pack.title}`}
                onClick={() => {
                  setPreview(null);
                  setPreviewError(null);
                  setPreviewLoading(true);
                  setSelected(pack);
                  setPreviewRetry((value) => value + 1);
                }}
              >
                Preview installation
              </Button>
            </li>
          ))}
        </ul>
      )}
      {selected ? (
        <div ref={previewRegion} tabIndex={-1} className="space-y-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-medium">Preview installation · {selected.title}</h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelected(null);
                setPreview(null);
              }}
            >
              Close preview
            </Button>
          </div>
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
        </div>
      ) : null}
    </PageShell>
  );
}
