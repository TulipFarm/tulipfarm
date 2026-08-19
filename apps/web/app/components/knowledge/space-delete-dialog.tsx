import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Modal } from "~/components/ui/modal";

export interface DeletableSpace {
  readonly id: string;
  readonly name: string;
  readonly pageCount: number;
}

/**
 * Confirms deleting a Space by stating what goes with it.
 *
 * Deliberately not `ConfirmModal`: that primitive takes a static description, and a generic "this
 * cannot be undone" is the sentence people have learned to click through. Naming the Space and
 * counting its Pages is the whole point of the interruption.
 */
export function SpaceDeleteDialog({
  open,
  space,
  onConfirm,
  onClose,
}: {
  open: boolean;
  space: DeletableSpace;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Delete space">
      <p className="text-foreground">
        Delete <span className="font-medium">{space.name}</span>?
      </p>
      <p className="mt-2 text-muted-foreground">
        {space.pageCount === 0 ? (
          <>It has no pages. This cannot be undone.</>
        ) : (
          <>
            Its{" "}
            <span className="font-medium text-foreground">
              {space.pageCount} {space.pageCount === 1 ? "page" : "pages"}
            </span>{" "}
            will be deleted with it, along with their history and links. This cannot be undone.
          </>
        )}
      </p>
      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-sm border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive"
        >
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" variant="destructive" onClick={confirm} disabled={busy}>
          {busy ? "Deleting…" : "Confirm delete"}
        </Button>
      </div>
    </Modal>
  );
}
