import { useEffect, useId, useState } from "react";
import { PartyAvatar } from "~/components/access/access-bits";
import { FileTeamShare } from "~/components/files/file-team-share";
import { Loader2, Trash2, UserRound, UsersRound } from "~/components/icons";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Combobox } from "~/components/ui/combobox";
import { Modal } from "~/components/ui/modal";
import { buildDirectory, type Directory, lookupParty } from "~/lib/access-directory";
import { type AuthzRole, listRoles } from "~/lib/authz";
import {
  type FileGrantee,
  type FileShare,
  fetchFileShares,
  type LibraryFile,
  shareFile,
  unshareFile,
} from "~/lib/files";
import { listUsers, type UserSummary } from "~/lib/users";
import { cn } from "~/lib/utils";

const KINDS = [
  { id: "user", label: "A person" },
  { id: "role", label: "Everyone with a role" },
] as const;

/** Email is unique per account, so it disambiguates two people who share a display name. */
function personOption(user: UserSummary): string {
  const name = user.name?.trim();
  return name && name.length > 0 ? `${name} (${user.email})` : user.email;
}

function roleOption(role: AuthzRole): string {
  const name = role.displayName?.trim();
  return name && name.length > 0 ? `${name} (${role.id})` : role.id;
}

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
  const [draft, setDraft] = useState("");
  const [users, setUsers] = useState<readonly UserSummary[]>([]);
  const [roles, setRoles] = useState<readonly AuthzRole[]>([]);
  const [directory, setDirectory] = useState<Directory>(() => buildDirectory([]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const granteeInputId = useId();

  const fileId = file?.id ?? null;

  useEffect(() => {
    if (fileId === null) return;
    const controller = new AbortController();
    setShares(null);
    setError(null);
    setDraft("");
    fetchFileShares(fileId, controller.signal)
      .then(setShares)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setShares([]);
        setError(err instanceof Error ? err.message : "Sharing could not be loaded.");
      });
    return () => controller.abort();
  }, [fileId]);

  // The pickers are a convenience, not a gate: someone who may not list the directory still gets a
  // field that accepts a principal or role id, so sharing never depends on either call landing.
  useEffect(() => {
    if (fileId === null) return;
    let live = true;
    listUsers()
      .then((items) => {
        if (!live) return;
        setUsers(items);
        setDirectory(buildDirectory(items));
      })
      .catch(() => undefined);
    listRoles()
      .then((body) => {
        if (live) setRoles(body.roles);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [fileId]);

  if (file === null) return null;

  async function run(action: () => Promise<void>) {
    if (fileId === null) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      setShares(await fetchFileShares(fileId));
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  const trimmed = draft.trim();
  const options =
    kind === "user"
      ? users.map(personOption)
      : [...roles].map(roleOption).sort((a, b) => a.localeCompare(b));

  /** A picked suggestion resolves to its id; anything else is taken as an id typed by hand. */
  function resolveId(): string {
    if (kind === "user") {
      return users.find((user) => personOption(user) === trimmed)?.id ?? trimmed;
    }
    return roles.find((role) => roleOption(role) === trimmed)?.id ?? trimmed;
  }

  function labelFor(share: FileShare): { title: string; detail: string } {
    if (share.kind === "role") {
      const role = roles.find((candidate) => candidate.id === share.id);
      return {
        title: role?.displayName?.trim() || share.id,
        detail: "Everyone with this role",
      };
    }
    const party = lookupParty(directory, share.id);
    return { title: party.name, detail: party.detail };
  }

  return (
    <Modal open onClose={onClose} title={`Share ${file.filename}`} className="max-w-lg">
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-3">
          <p className="text-muted-foreground text-sm">
            Anyone you add can read and download this file. They cannot share it on, and revoking
            takes effect the next time they open it.
          </p>

          <fieldset className="flex gap-1.5">
            <legend className="sr-only">Share with</legend>
            {KINDS.map((choice) => (
              <button
                key={choice.id}
                type="button"
                aria-pressed={kind === choice.id}
                onClick={() => {
                  setKind(choice.id);
                  setDraft("");
                }}
                className={cn(
                  "min-h-8 rounded-md border px-3 font-medium text-xs transition-colors",
                  kind === choice.id
                    ? "border-foreground bg-foreground text-background"
                    : "border-border text-muted-foreground hover:text-foreground"
                )}
              >
                {choice.label}
              </button>
            ))}
          </fieldset>

          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const id = resolveId();
              if (id.length === 0) return;
              void run(() => shareFile(file.id, { kind, id }));
            }}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <label htmlFor={granteeInputId} className="font-medium text-muted-foreground text-xs">
                {kind === "user" ? "Person" : "Role"}
              </label>
              <Combobox
                id={granteeInputId}
                value={draft}
                options={options}
                onValueChange={setDraft}
                placeholder={kind === "user" ? "Search by name or email" : "Search roles"}
                emptyLabel={
                  kind === "user"
                    ? "No match. Saved as a principal id."
                    : "No match. Saved as a role id."
                }
              />
            </div>
            <Button type="submit" size="sm" disabled={busy || trimmed.length === 0}>
              {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
              Share
            </Button>
          </form>

          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}

          {shares === null ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : shares.length === 0 ? (
            <p className="rounded-md border border-border border-dashed px-3 py-4 text-muted-foreground text-sm">
              Only you can read this file.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {shares.map((share) => {
                const { title, detail } = labelFor(share);
                return (
                  <li
                    key={`${share.kind}:${share.id}`}
                    className="flex items-center gap-3 px-3 py-2 text-sm"
                  >
                    {share.kind === "role" ? (
                      <span
                        aria-hidden
                        className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground"
                      >
                        <UsersRound className="size-4" />
                      </span>
                    ) : (
                      <PartyAvatar party={lookupParty(directory, share.id)} />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">{title}</p>
                      <p className="truncate text-muted-foreground text-xs">{detail}</p>
                    </div>
                    <Badge variant="neutral">
                      {share.kind === "role" ? (
                        <UsersRound className="size-3" aria-hidden />
                      ) : (
                        <UserRound className="size-3" aria-hidden />
                      )}
                      {share.kind === "role" ? "Role" : "Person"}
                    </Badge>
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
                );
              })}
            </ul>
          )}
        </section>

        <FileTeamShare fileId={file.id} />
      </div>
    </Modal>
  );
}
