import type { MetaFunction } from "@remix-run/react";
import { type FormEvent, useRef, useState } from "react";
import { PackPreviewPanel } from "~/components/packs/pack-preview";
import { PageShell } from "~/components/page-shell";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import { Textarea } from "~/components/ui/textarea";
import { ApiError } from "~/lib/api";
import { type PackPreview, type PackSource, previewPack } from "~/lib/packs";

export const meta: MetaFunction = () => [{ title: "Import Pack · tulipfarm" }];

export default function ImportPack() {
  const [inputKind, setInputKind] = useState<"url" | "yaml">("url");
  const [url, setUrl] = useState("");
  const [yaml, setYaml] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<{ message: string; path?: string } | null>(null);
  const [result, setResult] = useState<{ preview: PackPreview; source: PackSource } | null>(null);

  function resetPreview() {
    setResult(null);
    setError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    resetPreview();
    const source: PackSource = inputKind === "url" ? { url: url.trim() } : { yaml };
    if (source.url !== undefined) {
      try {
        const parsed = new URL(source.url);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error();
      } catch {
        setError({
          message: "Enter an HTTPS Pack URL without embedded credentials.",
          path: "/url",
        });
        return;
      }
    } else if (!source.yaml.trim()) {
      setError({ message: "Paste the complete Pack YAML.", path: "/yaml" });
      return;
    }
    inFlight.current = true;
    setPending(true);
    try {
      const preview = await previewPack(source);
      setResult({ preview, source });
    } catch (err) {
      setError({
        message:
          err instanceof ApiError && err.status === 403
            ? "You do not have permission to preview Packs."
            : "Could not preview the Pack. Check the source is reachable and contains valid Pack YAML, then try again.",
        path: err instanceof ApiError ? err.path : undefined,
      });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <PageShell
      title="Import Pack"
      actions={
        <Button asChild variant="outline">
          <Link to="/packs">Browse Packs</Link>
        </Button>
      }
    >
      <p className="max-w-2xl text-sm text-muted-foreground">
        Preview a Pack from an HTTPS URL or paste its complete YAML. The agent will adapt it to your
        existing business in Plan mode. You review and confirm the adapted plan before any changes.
      </p>
      <form onSubmit={submit} className="max-w-3xl space-y-4">
        <fieldset disabled={pending} className="space-y-4">
          <legend className="sr-only">Pack source</legend>
          <fieldset aria-label="Source format" className="flex gap-2">
            <Button
              type="button"
              variant={inputKind === "url" ? "default" : "outline"}
              aria-pressed={inputKind === "url"}
              onClick={() => {
                setInputKind("url");
                resetPreview();
              }}
            >
              HTTPS URL
            </Button>
            <Button
              type="button"
              variant={inputKind === "yaml" ? "default" : "outline"}
              aria-pressed={inputKind === "yaml"}
              onClick={() => {
                setInputKind("yaml");
                resetPreview();
              }}
            >
              Paste YAML
            </Button>
          </fieldset>
          {inputKind === "url" ? (
            <div className="space-y-1.5">
              <label htmlFor="pack-url" className="text-sm font-medium">
                Pack URL
              </label>
              <Input
                id="pack-url"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  resetPreview();
                }}
                placeholder="https://example.com/packs/customer-support.yaml"
                aria-invalid={error?.path === "/url"}
                aria-describedby={error ? "pack-error" : undefined}
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <label htmlFor="pack-yaml" className="text-sm font-medium">
                Pack YAML
              </label>
              <Textarea
                id="pack-yaml"
                value={yaml}
                onChange={(event) => {
                  setYaml(event.target.value);
                  resetPreview();
                }}
                rows={12}
                className="font-mono text-xs"
                placeholder={"apiVersion: tulipfarm.ai/v1\nkind: Pack\n…"}
                aria-invalid={error?.path === "/yaml"}
                aria-describedby={error ? "pack-error" : undefined}
              />
            </div>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? "Validating Pack…" : "Preview installation"}
          </Button>
        </fieldset>
        {pending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Validating the Pack without installing anything…
          </p>
        ) : null}
        {error ? (
          <p id="pack-error" role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        ) : null}
      </form>
      {result ? (
        <PackPreviewPanel
          key={result.preview.sha256}
          preview={result.preview}
          source={result.source}
        />
      ) : null}
    </PageShell>
  );
}
