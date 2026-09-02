import { type FormEvent, useState } from "react";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import type { SpaceInput } from "~/lib/knowledge-api";

/*
 * Mirrors the space-form look and server-authoritative error handling; empty optional fields
 * submit as null.
 */
const inputClass =
  "w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60";

export type SpaceFormProps = {
  mode: "create" | "edit";
  initial?: Partial<{ name: string; description: string | null }>;
  onSubmit: (body: SpaceInput) => void | Promise<void>;
  submitting: boolean;
  fieldErrors?: Record<string, string>;
  formError?: string | null;
  cancelTo: string;
};

export function SpaceForm({
  mode,
  initial,
  onSubmit,
  submitting,
  fieldErrors = {},
  formError,
  cancelTo,
}: SpaceFormProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [nameError, setNameError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") {
      setNameError("name is required");
      return;
    }
    onSubmit({
      name: trimmed,
      description: description.trim() === "" ? null : description.trim(),
    });
  }

  const shownNameError = nameError ?? fieldErrors.name;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      {formError ? (
        <p className="rounded-sm border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive">
          error: {formError}
        </p>
      ) : null}

      <div className="flex flex-col gap-1">
        <label htmlFor="name" className="text-xs text-muted-foreground">
          name<span className="text-primary"> *</span>
        </label>
        <input
          id="name"
          className={inputClass}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (nameError) setNameError(null);
          }}
          aria-invalid={nameError ? true : undefined}
          required
        />
        {shownNameError ? <p className="text-xs text-destructive">{shownNameError}</p> : null}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="description" className="text-xs text-muted-foreground">
          description<span className="opacity-60"> (optional)</span>
        </label>
        <textarea
          id="description"
          className={`${inputClass} min-h-20`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        {fieldErrors.description ? (
          <p className="text-xs text-destructive">{fieldErrors.description}</p>
        ) : null}
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
