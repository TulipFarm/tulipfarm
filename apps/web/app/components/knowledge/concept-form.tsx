import { Link } from "@remix-run/react";
import { PageEditor } from "@tulipfarm/editor";
import { type FormEvent, useState } from "react";
import { useWikiMentionExtensions } from "~/components/knowledge/use-wiki-mention-data";
import { Button } from "~/components/ui/button";
import { mergeTags } from "~/lib/inline-tags";
import { EMPTY_OKF_FIELDS, type OkfFields, parseOkf, serializeOkf } from "~/lib/okf";

/*
 * Dual-mode OKF page editor. "Guided" exposes the structured frontmatter (type/title/description/
 * resource/tags) plus a WYSIWYG markdown body (the shared @tulipfarm/editor PageEditor — markdown in
 * and out). "Raw" is a single textarea of the whole OKF string (the escape hatch — the body editor
 * normalizes markdown). Switching tabs converts via the client serialize/parse in lib/okf. Submit
 * posts `{ path, content }`; the server re-validates and any 400 is surfaced via `formError`.
 */

const inputClass =
  "w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60";

export type ConceptFormProps = {
  mode: "create" | "edit";
  /** The bundle this concept lives in — drives the `@`/`#` editor mention menus. */
  bundleId: string;
  /** Fixed bundle path of the concept on edit (read-only); seed/initial on create. */
  initialPath?: string;
  /** Lock the path field even on create (e.g. authoring the reserved `index` front page). */
  lockPath?: boolean;
  /** Full OKF markdown to seed the editor (edit, or pre-filling an existing front page). */
  initialContent?: string;
  /** Which tab to open on (front pages are frontmatter-less overrides → "raw"). */
  initialTab?: Tab;
  onSubmit: (path: string, content: string) => void | Promise<void>;
  submitting: boolean;
  formError?: string | null;
  cancelTo: string;
};

type Tab = "guided" | "raw";

export function ConceptForm({
  mode,
  bundleId,
  initialPath,
  lockPath,
  initialContent,
  initialTab,
  onSubmit,
  submitting,
  formError,
  cancelTo,
}: ConceptFormProps) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "guided");
  const [path, setPath] = useState(initialPath ?? "");
  const [fields, setFields] = useState<OkfFields>(() =>
    initialContent ? parseOkf(initialContent) : { ...EMPTY_OKF_FIELDS }
  );
  const [raw, setRaw] = useState(() => initialContent ?? serializeOkf({ ...EMPTY_OKF_FIELDS }));
  const pathLocked = mode === "edit" || !!lockPath;
  const mentionExtensions = useWikiMentionExtensions(bundleId);

  function setField<K extends keyof OkfFields>(key: K, value: OkfFields[K]) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  function switchTab(next: Tab) {
    if (next === tab) return;
    if (next === "raw") setRaw(serializeOkf(fields));
    else setFields(parseOkf(raw));
    setTab(next);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    // Guided mode: union inline `#tag` body tokens into the frontmatter tags so the stored `tags[]`
    // stays authoritative. Raw mode is the escape hatch — the author owns its frontmatter verbatim.
    const content =
      tab === "raw" ? raw : serializeOkf({ ...fields, tags: mergeTags(fields.tags, fields.body) });
    onSubmit(path.trim(), content);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      {formError ? (
        <p className="rounded-sm border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive">
          error: {formError}
        </p>
      ) : null}

      <div className="flex flex-col gap-1">
        <label htmlFor="path" className="text-xs text-muted-foreground">
          path<span className="text-primary"> *</span>
          <span className="opacity-60"> (e.g. tables/orders)</span>
        </label>
        <input
          id="path"
          className={inputClass}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="tables/orders"
          required
          readOnly={pathLocked}
          disabled={pathLocked}
        />
      </div>

      <div className="flex items-center gap-2 text-xs">
        <button
          type="button"
          onClick={() => switchTab("guided")}
          className={`cursor-pointer ${tabClass(tab === "guided")}`}
        >
          guided
        </button>
        <button
          type="button"
          onClick={() => switchTab("raw")}
          className={`cursor-pointer ${tabClass(tab === "raw")}`}
        >
          raw
        </button>
      </div>

      {tab === "guided" ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="title" className="text-xs text-muted-foreground">
              title<span className="opacity-60"> (optional)</span>
            </label>
            <input
              id="title"
              className={inputClass}
              value={fields.title}
              onChange={(e) => setField("title", e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="description" className="text-xs text-muted-foreground">
              description<span className="opacity-60"> (optional)</span>
            </label>
            <textarea
              id="description"
              className={`${inputClass} min-h-16`}
              value={fields.description}
              onChange={(e) => setField("description", e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="resource" className="text-xs text-muted-foreground">
              resource<span className="opacity-60"> (optional URI)</span>
            </label>
            <input
              id="resource"
              className={inputClass}
              value={fields.resource}
              onChange={(e) => setField("resource", e.target.value)}
              placeholder="https://…"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="tags" className="text-xs text-muted-foreground">
              tags<span className="opacity-60"> (comma-separated)</span>
            </label>
            <input
              id="tags"
              className={inputClass}
              value={fields.tags.join(", ")}
              onChange={(e) =>
                setField(
                  "tags",
                  e.target.value
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean)
                )
              }
              placeholder="sales, orders"
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              body<span className="opacity-60"> (press “/” for blocks)</span>
            </span>
            <div className="min-h-64 rounded-sm border border-border bg-background px-3 py-2 text-sm leading-relaxed">
              <PageEditor
                value={fields.body}
                onChange={(v) => setField("body", v)}
                mentionExtensions={mentionExtensions}
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <label htmlFor="raw" className="text-xs text-muted-foreground">
            content<span className="text-primary"> *</span>
            <span className="opacity-60"> (raw OKF: frontmatter + body)</span>
          </label>
          <textarea
            id="raw"
            className={`${inputClass} min-h-96 font-mono`}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            required
          />
        </div>
      )}

      <div className="flex items-center gap-2 pt-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? "saving…" : mode === "create" ? "Create" : "Save"}
        </Button>
        <Button asChild variant="outline">
          <Link to={cancelTo}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}

function tabClass(active: boolean): string {
  return active
    ? "text-primary underline underline-offset-4"
    : "text-muted-foreground hover:text-foreground";
}
