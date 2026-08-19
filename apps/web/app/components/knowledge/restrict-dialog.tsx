import { useEffect, useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { Modal } from "~/components/ui/modal";
import type {
  DirectorySubject,
  NamedReader,
  PageVisibility,
  SubjectDirectory,
  SubjectRef,
} from "~/lib/knowledge-api";

const key = (s: SubjectRef) => `${s.kind}:${s.id}`;

/**
 * Names who may read a Page or Space.
 *
 * Restricting *replaces* Business-wide access rather than adding exceptions, and that sentence is
 * the reason this dialog exists rather than a toggle: a person who believes they are adding a rule
 * to an open Page will pick one colleague and assume everyone else kept their access.
 *
 * An inherited restriction is shown as inherited and read-only. Offering an editable list an
 * ancestor will overrule invites the author to "correct" it and lose the work to a refusal.
 */
export function RestrictDialog({
  open,
  subjectLabel,
  visibility,
  directory,
  onRestrict,
  onClear,
  onClose,
}: {
  open: boolean;
  /** What is being restricted, named, so the dialog is never ambiguous about its target. */
  subjectLabel: string;
  visibility: PageVisibility;
  directory: SubjectDirectory;
  onRestrict: (subjects: SubjectRef[]) => Promise<void>;
  onClear: () => Promise<void>;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteId = useId();

  useEffect(() => {
    if (open) setPicked(new Set(visibility.own.map(key)));
  }, [open, visibility.own]);

  const groups: Array<{ heading: string; items: DirectorySubject[] }> = [
    { heading: "People", items: directory.users },
    { heading: "Teams", items: directory.teams },
    { heading: "Roles", items: directory.roles },
  ];

  const all = [...directory.users, ...directory.teams, ...directory.roles];
  const chosen = all.filter((s) => picked.has(key(s))).map((s) => ({ kind: s.kind, id: s.id }));
  const isInherited = visibility.scope === "inherited";

  function toggle(s: DirectorySubject) {
    setPicked((prev) => {
      const next = new Set(prev);
      const k = key(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
    setError(null);
  }

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      onClose();
    } catch (err) {
      // The picked names stay put: the server refused the grant whole, and the person needs to see
      // what they had chosen in order to correct it.
      setError(err instanceof Error ? err.message : "could not save");
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (chosen.length === 0) {
      setError("Pick at least one person, team, or role — an empty list would lock everyone out.");
      return;
    }
    void run(() => onRestrict(chosen));
  }

  return (
    <Modal open={open} onClose={onClose} title={`Who can read ${subjectLabel}`}>
      {isInherited ? (
        <p data-testid="inherited-note" className="text-muted-foreground">
          This inherits its restriction from{" "}
          <span className="font-medium text-foreground">{visibility.inheritedFrom?.title}</span>.
          Change it there, or restrict this page further to a subset of those readers.
        </p>
      ) : (
        <p id={noteId} data-testid="replace-note" className="text-muted-foreground">
          Restricting <span className="font-medium text-foreground">replaces</span> access for
          everyone in the business with the list below. It does not add exceptions on top of
          business-wide access.
        </p>
      )}

      <fieldset className="mt-4 max-h-64 overflow-y-auto" disabled={busy}>
        <legend className="sr-only">People, teams, and roles that may read {subjectLabel}</legend>
        {groups.map((g) =>
          g.items.length === 0 ? null : (
            <div key={g.heading} className="mb-3">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {g.heading}
              </p>
              <ul>
                {g.items.map((s) => (
                  <li key={key(s)}>
                    <label className="flex min-h-11 items-center gap-2 rounded px-1 hover:bg-muted">
                      <input
                        type="checkbox"
                        checked={picked.has(key(s))}
                        onChange={() => toggle(s)}
                        aria-describedby={isInherited ? undefined : noteId}
                      />
                      <span>{s.label}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )
        )}
      </fieldset>

      {visibility.readers.length > 0 && (
        <div data-testid="who-can-see" className="mt-2 border-t border-border pt-3">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Can read this today
          </p>
          <ul className="text-muted-foreground">
            {visibility.readers.map((r: NamedReader) => (
              <li key={r.id}>
                <span className="text-foreground">{r.label}</span>
                {r.via && <span> — via {r.via.id}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-danger">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {visibility.scope === "own" && (
          <Button type="button" variant="ghost" onClick={() => void run(onClear)} disabled={busy}>
            Return to the whole business
          </Button>
        )}
        <Button type="button" onClick={save} disabled={busy}>
          Restrict{busy ? "ing…" : ""}
        </Button>
      </div>
    </Modal>
  );
}
