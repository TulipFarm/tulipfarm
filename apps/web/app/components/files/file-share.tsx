import { Loader2, Trash2, UserRound, UsersRound } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Modal } from "~/components/ui/modal";
import { Select } from "~/components/ui/select";
import {
  type FileGrantee,
  type FileShare,
  fetchFileShares,
  type LibraryFile,
  shareFile,
  unshareFile,
} from "~/lib/files";

/**
 * Who else may read one File.
 *
 * The list is loaded when the dialog opens rather than carried on the row, because a share is a
 * fact about a File that changes without the library reloading, and a stale count next to a
 * revoke button is the one thing a person must never see here.
 */
export function ShareDialog({ file, onClose }: { file: LibraryFile | null; onClose: () => void }) {
  const [shares, setShares] = useState<readonly FileShare[] | null>(null);
  const [kind, setKind] = useState<FileGrantee["kind"]>("user");
  const [granteeId, setGranteeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kindId = useId();
  const granteeInputId = useId();

  const fileId = file?.id ?? null;

  useEffect(() => {
    if (fileId === null) return;
    const controller = new AbortController();
    setShares(null);
    setError(null);
    setGranteeId("");
    fetchFileShares(fileId, controller.signal)
      .then(setShares)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setShares([]);
        setError(err instanceof Error ? err.message : "Sharing could not be loaded.");
      });
    return () => controller.abort();
  }, [fileId]);

  if (file === null) return null;

  async function run(action: () => Promise<void>) {
    if (fileId === null) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      setShares(await fetchFileShares(fileId));
      setGranteeId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  const trimmed = granteeId.trim();

  return (
    <Modal open onClose={onClose} title={`Share ${file.filename}`}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Anyone you add can read and download this file. They cannot share it on, and revoking
          takes effect the next time they open it.
        </p>

        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed.length === 0) return;
            void run(() => shareFile(file.id, { kind, id: trimmed }));
          }}
        >
          <div className="flex flex-col gap-1">
            <label htmlFor={kindId} className="text-xs font-medium text-muted-foreground">
              Share with
            </label>
            <Select
              id={kindId}
              value={kind}
              onChange={(event) => setKind(event.target.value as FileGrantee["kind"])}
            >
              <option value="user">A person</option>
              <option value="role">Everyone with a role</option>
            </Select>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label htmlFor={granteeInputId} className="text-xs font-medium text-muted-foreground">
              {kind === "user" ? "Their principal id" : "Role id"}
            </label>
            <Input
              id={granteeInputId}
              value={granteeId}
              onChange={(event) => setGranteeId(event.target.value)}
              placeholder={kind === "user" ? "principal id" : "support"}
              autoComplete="off"
            />
          </div>
          <Button type="submit" size="sm" disabled={busy || trimmed.length === 0}>
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            Share
          </Button>
        </form>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {shares === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : shares.length === 0 ? (
          <p className="rounded-sm border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
            Only you can read this file.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-sm border border-border">
            {shares.map((share) => (
              <li
                key={`${share.kind}:${share.id}`}
                className="flex items-center gap-2 px-3 py-2 text-sm"
              >
                <Badge variant="neutral">
                  {share.kind === "role" ? (
                    <UsersRound className="size-3" aria-hidden />
                  ) : (
                    <UserRound className="size-3" aria-hidden />
                  )}
                  {share.kind === "role" ? "Role" : "Person"}
                </Badge>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                  {share.id}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={`Revoke access for ${share.id}`}
                  onClick={() => void run(() => unshareFile(file.id, share))}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
