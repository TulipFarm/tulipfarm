import { Link } from "@remix-run/react";
import { type FormEvent, type ReactNode, useState } from "react";
import { MarkdownView } from "~/components/markdown-view";
import { Button } from "~/components/ui/button";
import type { DocumentInput } from "~/lib/knowledge-api";

/*
 * Bespoke create/edit form for knowledge documents. Mirrors resource-form's look (local `inputClass`,
 * muted labels, server-authoritative errors via `fieldErrors`/`formError`) but adds the markdown-specific
 * affordances the generic form lacks: a write/preview toggle (reusing MarkdownView) and a comma-separated
 * tags input that round-trips to `string[]`. No file-upload affordance (AC-V1-004).
 */
const inputClass =
  "w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60";

export type DocFormInitial = {
  title: string;
  content: string;
  tags: string[];
  domain: string | null;
  alwaysLoadForAgents: boolean;
};

export type DocFormProps = {
  mode: "create" | "edit";
  initial?: Partial<DocFormInitial>;
  onSubmit: (body: DocumentInput) => void | Promise<void>;
  submitting: boolean;
  fieldErrors?: Record<string, string>;
  formError?: string | null;
  cancelTo: string;
};

export function DocForm({
  mode,
  initial,
  onSubmit,
  submitting,
  fieldErrors = {},
  formError,
  cancelTo,
}: DocFormProps) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [content, setContent] = useState(initial?.content ?? "");
  const [tags, setTags] = useState((initial?.tags ?? []).join(", "));
  const [domain, setDomain] = useState(initial?.domain ?? "");
  const [always, setAlways] = useState(initial?.alwaysLoadForAgents ?? false);
  const [preview, setPreview] = useState(false);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSubmit({
      title: title.trim(),
      content,
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      domain: domain.trim() === "" ? null : domain.trim(),
      alwaysLoadForAgents: always,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      {formError ? (
        <p className="rounded-sm border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive">
          error: {formError}
        </p>
      ) : null}

      <Labeled name="title" required error={fieldErrors.title}>
        <input
          id="title"
          className={inputClass}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
      </Labeled>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <label htmlFor="content" className="text-xs text-muted-foreground">
            content<span className="text-primary"> *</span>
            <span className="opacity-60"> (markdown)</span>
          </label>
          <div className="flex gap-2 text-xs">
            <button type="button" onClick={() => setPreview(false)} className={tabClass(!preview)}>
              write
            </button>
            <button type="button" onClick={() => setPreview(true)} className={tabClass(preview)}>
              preview
            </button>
          </div>
        </div>
        {preview ? (
          <div className="min-h-40 rounded-sm border border-border bg-background px-3 py-2">
            {content.trim() ? (
              <MarkdownView>{content}</MarkdownView>
            ) : (
              <p className="text-sm text-muted-foreground">nothing to preview</p>
            )}
          </div>
        ) : (
          <textarea
            id="content"
            className={`${inputClass} min-h-40 font-mono`}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            required
          />
        )}
        {fieldErrors.content ? (
          <p className="text-xs text-destructive">{fieldErrors.content}</p>
        ) : null}
      </div>

      <Labeled name="tags" hint="comma-separated" error={fieldErrors.tags}>
        <input
          id="tags"
          className={inputClass}
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="onboarding, sales"
        />
      </Labeled>

      <Labeled name="domain" hint="optional scope" error={fieldErrors.domain}>
        <input
          id="domain"
          className={inputClass}
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
        />
      </Labeled>

      <div className="flex items-center gap-2">
        <input
          id="alwaysLoadForAgents"
          type="checkbox"
          className="size-4 accent-primary"
          checked={always}
          onChange={(e) => setAlways(e.target.checked)}
        />
        <label htmlFor="alwaysLoadForAgents" className="text-xs text-muted-foreground">
          alwaysLoadForAgents<span className="opacity-60"> (inject into agent context)</span>
        </label>
      </div>

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

function Labeled({
  name,
  required,
  hint,
  error,
  children,
}: {
  name: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-xs text-muted-foreground">
        {name}
        {required ? <span className="text-primary"> *</span> : null}
        {hint ? <span className="opacity-60"> ({hint})</span> : null}
      </label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
