import { useState } from "react";
import { Pencil, Plus, Trash2 } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { roleTitle, summarizeRole } from "~/lib/access-language";
import { type AuthzRole, type CapabilityCatalog, deleteLevel } from "~/lib/authz";
import { RawGrantList, RoleCard, TechnicalDetails } from "./access-bits";
import { type EditableLevel, LevelBuilder } from "./level-builder";

export function LevelsPanel({
  roles,
  catalog,
  onChanged,
  getErrorMessage,
}: {
  roles: AuthzRole[];
  catalog: CapabilityCatalog | null;
  onChanged: () => void;
  getErrorMessage: (error: unknown) => string;
}) {
  const [building, setBuilding] = useState(false);
  const [editing, setEditing] = useState<EditableLevel | undefined>(undefined);
  return (
    <Panel
      title="What each level of access means"
      description="Levels are named bundles of things people can do. Create one for each kind of job in your business."
      flush
      actions={
        catalog ? (
          <Button variant="outline" size="sm" onClick={() => setBuilding(true)}>
            <Plus className="size-4" />
            New level
          </Button>
        ) : null
      }
    >
      <LevelBuilder
        open={building}
        onClose={() => {
          setBuilding(false);
          setEditing(undefined);
        }}
        catalog={catalog}
        onCreated={onChanged}
        editing={editing}
      />
      {roles.length === 0 ? (
        <PanelEmpty>No access levels defined.</PanelEmpty>
      ) : (
        <ul className="divide-y divide-border">
          {roles.map((role) => (
            <li key={role.id} className="space-y-2 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <RoleCard summary={summarizeRole(role)} className="min-w-0 flex-1" />
                {role.source === "authored" && role.slug ? (
                  <div className="flex shrink-0 items-start gap-1">
                    <EditLevelButton
                      role={role}
                      slug={role.slug}
                      onEdit={(level) => {
                        setEditing(level);
                        setBuilding(true);
                      }}
                    />
                    <DeleteLevelButton
                      role={role}
                      slug={role.slug}
                      onDeleted={onChanged}
                      getErrorMessage={getErrorMessage}
                    />
                  </div>
                ) : null}
              </div>
              <TechnicalDetails>
                <RawGrantList grants={role.grants} />
              </TechnicalDetails>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Only authored levels can be edited; built-ins have no Soul artifact to rewrite. */
function EditLevelButton({
  role,
  slug,
  onEdit,
}: {
  role: AuthzRole;
  slug: string;
  onEdit: (level: EditableLevel) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() =>
        onEdit({
          slug,
          displayName: role.displayName ?? slug,
          capabilities: role.grants
            .filter((grant) => grant.effect === "allow")
            .map((grant) => grant.action),
        })
      }
    >
      <Pencil className="size-4" />
      Edit
    </Button>
  );
}

/** Deleting a level cascades to every holder; withhold the button when `slug` is absent. */
function DeleteLevelButton({
  role,
  slug,
  onDeleted,
  getErrorMessage,
}: {
  role: AuthzRole;
  slug: string;
  onDeleted: () => void;
  getErrorMessage: (error: unknown) => string;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteLevel(slug);
      onDeleted();
    } catch (err) {
      setError(getErrorMessage(err));
      setArmed(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shrink-0 space-y-1 text-right">
      <Button
        variant={armed ? "destructive" : "ghost"}
        size="sm"
        onClick={remove}
        disabled={busy}
        aria-label={`Delete the ${roleTitle(role.id, role.displayName)} level`}
      >
        <Trash2 className="size-4" />
        {busy ? "Deleting…" : armed ? "Yes, delete it" : "Delete"}
      </Button>
      {armed && !busy ? (
        <p className="max-w-48 text-xs text-muted-foreground">
          Everybody with this level loses it straight away.
        </p>
      ) : null}
      {error ? <p className="text-xs text-status-danger">{error}</p> : null}
    </div>
  );
}
