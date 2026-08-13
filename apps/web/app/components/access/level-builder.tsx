/*
 * Create an access level.
 *
 * The screen this replaces was a chooser with three fixed choices and no way to make a fourth, so
 * an owner whose business did not happen to match "full access / everyday access" had nowhere to
 * go. This is the "make a fourth" path.
 *
 * Two rules shape it, and both come from mistakes already made on this surface:
 *
 * 1. **Every option comes from the server.** The capabilities listed here are derived from the
 *    Tools themselves, so the screen cannot offer permission to do something the gate would not
 *    recognise. Six separate bugs on this surface were the same bug — a hand-written list of
 *    actions drifting away from the vocabulary the gate actually evaluates — and a picker built
 *    from a local constant would be the seventh.
 * 2. **What cannot be granted is said out loud.** A picker that silently omits what it cannot
 *    express leaves the owner hunting for a permission the screen decided not to mention.
 */

import { AlertTriangle, Check, Loader2, Pencil, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Sheet } from "~/components/ui/sheet";
import { type Capability, type CapabilityCatalog, createLevel, updateLevel } from "~/lib/authz";
import { cn } from "~/lib/utils";

function matches(capability: Capability, query: string): boolean {
  if (query === "") return true;
  const needle = query.toLowerCase();
  return (
    capability.label.toLowerCase().includes(needle) ||
    capability.action.toLowerCase().includes(needle) ||
    capability.tools.some((tool) => tool.toLowerCase().includes(needle))
  );
}

/** The level being edited, or `undefined` when the sheet is creating a new one. */
export interface EditableLevel {
  slug: string;
  displayName: string;
  capabilities: readonly string[];
}

export function LevelBuilder({
  open,
  onClose,
  catalog,
  onCreated,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  /** `null` while the catalog is still loading, so the sheet can say so instead of looking empty. */
  catalog: CapabilityCatalog | null;
  onCreated: (level: { id: string; slug: string; displayName: string }) => void;
  editing?: EditableLevel;
}) {
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Editing starts from what the level already grants, not from a blank sheet. An owner adding one
   * capability must not have to remember and re-tick the other nine — and a half-filled sheet
   * saved by mistake would silently strip access from everybody holding the level.
   */
  useEffect(() => {
    if (!open) return;
    setName(editing?.displayName ?? "");
    setChosen(new Set(editing?.capabilities ?? []));
    setQuery("");
    setError(null);
  }, [open, editing]);

  const areas = useMemo(() => {
    if (!catalog) return [];
    return catalog.areas
      .map((area) => ({
        ...area,
        capabilities: area.capabilities.filter((capability) => matches(capability, query)),
      }))
      .filter((area) => area.capabilities.length > 0);
  }, [catalog, query]);

  function reset() {
    setName("");
    setQuery("");
    setChosen(new Set());
    setError(null);
  }

  function toggle(id: string) {
    setChosen((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function toggleArea(capabilities: readonly Capability[], on: boolean) {
    setChosen((previous) => {
      const next = new Set(previous);
      for (const capability of capabilities) {
        if (on) next.add(capability.id);
        else next.delete(capability.id);
      }
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const level = editing
        ? await updateLevel(editing.slug, name.trim(), [...chosen])
        : await createLevel(name.trim(), [...chosen]);
      onCreated(level);
      reset();
      onClose();
    } catch (err) {
      // The server names the capability it could not grant and the reason a name was refused;
      // replacing that with "Something went wrong" would hide the only actionable part.
      setError(
        err instanceof Error
          ? err.message
          : `Could not ${editing ? "save" : "create"} this access level.`
      );
    } finally {
      setSaving(false);
    }
  }

  const canSave = name.trim().length > 0 && chosen.size > 0 && !saving;

  return (
    <Sheet
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={editing ? `Edit ${editing.displayName}` : "Create an access level"}
    >
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">
          {editing
            ? "Change the name or what people at this level can do. Everybody who already has this level keeps it, and picks up the change straight away."
            : "An access level is a named bundle of things someone is allowed to do. Give it a name your team would recognise, then tick what people at that level can do."}
        </p>

        <div className="block space-y-1.5">
          <label htmlFor="level-name" className="text-sm font-medium text-foreground">
            Name
          </label>
          <span className="relative block">
            <Pencil className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="level-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Kitchen staff"
              className="pl-9"
            />
          </span>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-foreground">What they can do</span>
            <span className="text-xs text-muted-foreground">
              {chosen.size === 0 ? "Nothing picked yet" : `${chosen.size} picked`}
            </span>
          </div>

          <span className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search, e.g. invoice, GitHub, message"
              className="pl-9"
              aria-label="Search what they can do"
            />
          </span>

          {catalog === null ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : areas.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {query === ""
                ? "Nothing can be granted yet. Connect an integration or add a resource first."
                : `Nothing matches "${query}".`}
            </p>
          ) : (
            <div className="space-y-4">
              {areas.map((area) => {
                const all = area.capabilities.every((capability) => chosen.has(capability.id));
                return (
                  <section key={area.id} className="rounded-md border border-border">
                    <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
                      <h3 className="text-sm font-medium text-foreground">{area.label}</h3>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggleArea(area.capabilities, !all)}
                      >
                        {all ? "Clear all" : "Pick all"}
                      </Button>
                    </header>
                    <ul>
                      {area.capabilities.map((capability) => {
                        const picked = chosen.has(capability.id);
                        return (
                          <li key={capability.id}>
                            <label
                              htmlFor={`cap-${capability.id}`}
                              className={cn(
                                "flex cursor-pointer items-start gap-3 px-3 py-2.5",
                                "hover:bg-muted/40"
                              )}
                            >
                              <Checkbox
                                id={`cap-${capability.id}`}
                                className="mt-0.5"
                                checked={picked}
                                onChange={() => toggle(capability.id)}
                                aria-label={capability.label}
                              />
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-2">
                                  <span className="text-sm text-foreground">
                                    {capability.label}
                                  </span>
                                  {capability.changesThings ? (
                                    <Badge variant="warning">Changes things</Badge>
                                  ) : null}
                                </span>
                                <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                                  {capability.action}
                                </span>
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}

          {catalog && catalog.unavailable.length > 0 ? (
            <details className="rounded-md border border-border px-3 py-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {catalog.unavailable.length} thing
                {catalog.unavailable.length === 1 ? "" : "s"} cannot be put in an access level
              </summary>
              <ul className="mt-2 space-y-1">
                {catalog.unavailable.map((entry) => (
                  <li key={entry.action} className="font-mono text-xs text-muted-foreground">
                    {entry.action}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                These stay with full access only. Ask an administrator if someone needs them.
              </p>
            </details>
          ) : null}
        </div>

        {error ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md border border-status-danger/40 bg-status-danger/5 px-3 py-2 text-sm text-status-danger"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
          <Button
            variant="ghost"
            onClick={() => {
              reset();
              onClose();
            }}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            {editing ? "Save changes" : "Create level"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
