import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Modal } from "~/components/ui/modal";
import type { PageMovePreview, SubjectDirectory, SubjectRef } from "~/lib/knowledge-api";

/**
 * Turns the principal refs a move preview returns into names a person can read.
 *
 * Deliberately does not expand a Team into its members: the preview is passive and unasked-for,
 * and naming the members of a Team the caller may not enumerate would disclose more than the
 * question did. `page-move.ts` makes the same call for the same reason.
 */
function labeller(directory: SubjectDirectory) {
  const all = [...directory.users, ...directory.teams, ...directory.roles];
  const byKey = new Map(all.map((s) => [`${s.kind}\u0000${s.id}`, s.label]));
  return (p: SubjectRef) => {
    const known = byKey.get(`${p.kind}\u0000${p.id}`);
    if (known) return known;
    // Everyone-in-the-business is a role, not a person, and reads badly as an identifier.
    if (p.kind === "role" && p.id === "role-everyone") return "everyone in the business";
    return p.kind === "user" ? "a person you cannot see" : p.id;
  };
}

/**
 * Warns before a move changes who can read a Page.
 *
 * A move that changes nothing proceeds without asking. A confirmation on every move trains people
 * to dismiss it, and a warning that fires constantly protects nobody — so the silence in the
 * unchanged case is a feature, not an omission.
 */
export function MoveDialog({
  open,
  pageTitle,
  destination,
  preview,
  directory,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  pageTitle: string;
  destination: string;
  preview: PageMovePreview;
  directory: SubjectDirectory;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = labeller(directory);
  const harmless = preview.effect === "unchanged";
  const fired = useRef(false);

  useEffect(() => {
    if (!open || !harmless || fired.current) return;
    fired.current = true;
    void (async () => {
      try {
        await onConfirm();
      } catch (err) {
        setError(err instanceof Error ? err.message : "move failed");
      }
    })();
  }, [open, harmless, onConfirm]);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "move failed");
    } finally {
      setBusy(false);
    }
  }

  if (harmless) {
    return error ? (
      <Modal open={open} onClose={onCancel} title="Move failed">
        <p role="alert" className="text-danger">
          {error}
        </p>
      </Modal>
    ) : null;
  }

  const nested = preview.descendants ?? [];
  const changedNested = nested.filter((d) => d.effect !== "unchanged");

  return (
    <Modal open={open} onClose={onCancel} title={`Move ${pageTitle}`}>
      <p className="text-muted-foreground">
        Moving this to <span className="font-medium text-foreground">{destination}</span> changes
        who can read it.
      </p>

      {preview.gained.length > 0 && (
        <div data-testid="gained" className="mt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Gains access
          </p>
          <p className="text-foreground">{preview.gained.map(label).join(", ")}</p>
        </div>
      )}

      {preview.lost.length > 0 && (
        <div data-testid="lost" className="mt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Loses access
          </p>
          <p className="text-foreground">{preview.lost.map(label).join(", ")}</p>
        </div>
      )}

      {preview.ownRestrictionSurvives !== null && (
        <p data-testid="own-restriction" className="mt-3 text-muted-foreground">
          {preview.ownRestrictionSurvives
            ? "This page's own restriction still holds at the destination."
            : "This page's own restriction no longer holds at the destination."}
        </p>
      )}

      {nested.length > 0 && (
        <div data-testid="descendants" className="mt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {nested.length} {nested.length === 1 ? "page" : "pages"} nested beneath move too
          </p>
          {changedNested.length === 0 ? (
            <p className="text-muted-foreground">None of them change readership.</p>
          ) : (
            <ul className="text-muted-foreground">
              {changedNested.map((d) => (
                <li key={d.pageId}>
                  <span className="text-foreground">{d.path}</span> — {d.effect}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-danger">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" onClick={confirm} disabled={busy}>
          Move{busy ? "…" : ""}
        </Button>
      </div>
    </Modal>
  );
}
