import { useEffect, useState } from "react";
import { ApiError } from "~/lib/api";
import { getSoulFile, type SoulFile } from "~/lib/soul";
import { useHighlighted } from "~/lib/use-highlighted";

/*
 * Read-only source viewer for a single soul file. Fetches raw content from the API, then
 * renders it with Shiki (client-side).
 */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function SoulFileViewer({ path }: { path: string | null }) {
  const [file, setFile] = useState<SoulFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setFile(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFile(null); // drop stale size/content from the previous selection immediately
    getSoulFile(path)
      .then((f) => {
        if (!cancelled) setFile(f);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "failed to load file");
          setFile(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const showable = file && !file.binary && !file.tooLarge ? file : null;
  const html = useHighlighted(showable?.content ?? null, showable?.language ?? "plaintext");

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Select a file to view its source.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted px-3 py-2">
        <span className="truncate font-mono text-xs text-foreground" title={path}>
          {path}
        </span>
        {file ? (
          <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(file.size)}</span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p
            role="alert"
            className="m-3 rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : file?.tooLarge ? (
          <p className="p-4 text-sm text-muted-foreground">
            File too large to preview ({formatBytes(file.size)}).
          </p>
        ) : file?.binary ? (
          <p className="p-4 text-sm text-muted-foreground">Binary file — not shown.</p>
        ) : html ? (
          <div
            className="text-sm [&_pre]:min-h-full [&_pre]:p-4"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki output is static, HTML-escaped source from the user's own authed soul repo.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : null}
      </div>
    </div>
  );
}
