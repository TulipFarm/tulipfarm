import { Link } from "@remix-run/react";
import { PageEditor } from "@tulipfarm/editor";
import { type FormEvent, useState } from "react";
import { useWikiMentionExtensions } from "~/components/knowledge/use-wiki-mention-data";
import { Button } from "~/components/ui/button";
import { mergeTags } from "~/lib/inline-tags";
import { EMPTY_OKF_FIELDS, type OkfFields, parseOkf, serializeOkf } from "~/lib/okf";

/* Switching tabs converts via the client serialize/parse in lib/okf. */

const inputClass =
  "w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60";

export type PageFormProps = {
  mode: "create" | "edit";
  spaceId: string;
  initialPath?: string;
  lockPath?: boolean;
  initialContent?: string;
  initialTab?: Tab;
  onSubmit: (path: string, content: string) => void | Promise<void>;
  submitting: boolean;
  formError?: string | null;
  cancelTo: string;
};

type Tab = "guided" | "raw";

export function PageForm({
  mode,
  spaceId,
  initialPath,
  lockPath,
  initialContent,
  initialTab,
  onSubmit,
  submitting,
  formError,
  cancelTo,
}: PageFormProps) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "guided");
  const [path, setPath] = useState(initialPath ?? "");
  const [fields, setFields] = useState<OkfFields>(() =>
    initialContent ? parseOkf(initialContent) : { ...EMPTY_OKF_FIELDS }
  );
  const [raw, setRaw] = useState(() => initialContent ?? serializeOkf({ ...EMPTY_OKF_FIELDS }));
  const pathLocked = mode === "edit" || !!lockPath;
  const mentionExtensions = useWikiMentionExtensions(spaceId);

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
