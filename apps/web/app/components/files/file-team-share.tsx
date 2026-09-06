import type { TeamAssetAccessLevel } from "@tulipfarm/schema";
import { useEffect, useId, useState } from "react";
import { Loader2, Trash2 } from "~/components/icons";
import { TeamAvatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Combobox } from "~/components/ui/combobox";
import {
  getTeamAssetAccess,
  listTeams,
  proposeTeamAssetOperation,
  type TeamAssetOwnership,
  type TeamDirectoryEntry,
  updateTeamAssetShares,
} from "~/lib/teams";

const LEVELS: readonly TeamAssetAccessLevel[] = ["view", "use", "edit"];

function levelLabel(access: TeamAssetAccessLevel): string {
  if (access === "edit") return "Edit";
  if (access === "use") return "Use";
  return "View";
}

/** `displayName — id`, so two Teams that share a name are still distinguishable in one text field. */
function optionFor(team: TeamDirectoryEntry): string {
  return `${team.displayName} — ${team.id}`;
}

/**
 * Team ownership and Team sharing for one File.
 *
 * Separate from the person/role list above it because it speaks a different API: personal shares
 * are `file_shares` rows the Files service owns, while a Team grant lives in `asset_ownership` and
 * is replaced wholesale against a `revision`. Mixing them into one list would mean one save path
 * silently discarding the other's concurrent edit.
 */
export function FileTeamShare({ fileId }: { fileId: string }) {
  const [ownership, setOwnership] = useState<TeamAssetOwnership | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [teams, setTeams] = useState<readonly TeamDirectoryEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [level, setLevel] = useState<TeamAssetAccessLevel>("view");
  // The field holds its own text: a Combobox is a text input, so binding it straight to `level`
  // and discarding onValueChange would make it silently unwritable.
  const [levelText, setLevelText] = useState(() => levelLabel("view"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const teamFieldId = useId();
  const levelFieldId = useId();

  useEffect(() => {
    let live = true;
    setOwnership(null);
    setError(null);
    Promise.all([getTeamAssetAccess("file", fileId), listTeams()])
      .then(([projection, directory]) => {
        if (!live) return;
        setOwnership(projection.ownership);
        setCanManage(projection.access.canManageOwnership);
        setTeams(directory.teams.filter((team) => team.status === "active"));
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : "Team access could not be loaded.");
      });
    return () => {
      live = false;
    };
  }, [fileId]);

  async function reload() {
    const projection = await getTeamAssetAccess("file", fileId);
    setOwnership(projection.ownership);
    setCanManage(projection.access.canManageOwnership);
  }

  async function run(action: (current: TeamAssetOwnership) => Promise<void>, success: string) {
    if (ownership === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action(ownership);
      await reload();
      setNotice(success);
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  const nameFor = (teamId: string) =>
    teams.find((team) => team.id === teamId)?.displayName ?? teamId;

  /* The mark is keyed on the slug so one Team looks the same here as in the Team directory. */
  const slugFor = (teamId: string) => teams.find((team) => team.id === teamId)?.slug ?? teamId;

  const options = teams.map(optionFor);
  const chosen = teams.find((team) => optionFor(team) === draft.trim() || team.id === draft.trim());

  const ownerTeamIds = (ownership?.owners ?? [])
    .filter((owner): owner is { kind: "team"; teamId: string } => owner.kind === "team")
    .map((owner) => owner.teamId);

  return (
    <section className="flex flex-col gap-3 border-t border-border pt-4">
      <div className="flex flex-col gap-1">
        <h3 className="font-medium text-foreground text-sm">Teams</h3>
        <p className="text-muted-foreground text-sm">
          A Team that owns this file keeps it when the person who uploaded it leaves. Sharing with a
          Team reaches everyone in it, including its sub-teams.
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      {notice ? <p className="text-muted-foreground text-sm">{notice}</p> : null}

      {ownership === null ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-xs">Owned by</span>
            {ownerTeamIds.length === 0 ? (
              <Badge variant="neutral">Nobody but the uploader</Badge>
            ) : (
              ownerTeamIds.map((teamId) => (
                <span
                  key={teamId}
                  className="inline-flex items-center gap-1.5 rounded-sm bg-muted px-2 py-1 font-medium text-foreground text-xs"
                >
                  <TeamAvatar identity={slugFor(teamId)} className="size-4 rounded-[0.25rem]" />
                  {nameFor(teamId)}
                </span>
              ))
            )}
          </div>

          {canManage ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (chosen === undefined) {
                  setError("Pick a Team from the list.");
                  return;
                }
                void run(
                  (current) =>
                    updateTeamAssetShares(
                      "file",
                      fileId,
                      [
                        ...current.shares.filter((share) => share.teamId !== chosen.id),
                        { teamId: chosen.id, access: level },
                      ],
                      current.revision
                    ).then(() => undefined),
                  "Team sharing updated."
                );
              }}
            >
              <div className="flex items-end gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <label
                    htmlFor={teamFieldId}
                    className="font-medium text-muted-foreground text-xs"
                  >
                    Team
                  </label>
                  <Combobox
                    id={teamFieldId}
                    value={draft}
                    options={options}
                    onValueChange={setDraft}
                    placeholder="Search Teams"
                    emptyLabel="No Team by that name."
                  />
                </div>
                <div className="flex w-28 shrink-0 flex-col gap-1">
                  <label
                    htmlFor={levelFieldId}
                    className="font-medium text-muted-foreground text-xs"
                  >
                    They can
                  </label>
                  <Combobox
                    id={levelFieldId}
                    value={levelText}
                    options={LEVELS.map(levelLabel)}
                    onValueChange={setLevelText}
                    onCommit={(next) => {
                      const match = LEVELS.find(
                        (candidate) =>
                          levelLabel(candidate).toLowerCase() === next.trim().toLowerCase()
                      );
                      // An unrecognised level snaps back rather than being sent: the API takes
                      // three values and a typo must not silently become "view".
                      setLevel(match ?? level);
                      setLevelText(levelLabel(match ?? level));
                    }}
                  />
                </div>
              </div>
              {/* Two rows, not four columns: this dialog has a fixed width, so packing an owner
                  action beside two fields and a submit collapses every label to one word a line. */}
              <div className="flex items-center justify-end gap-2">
                {ownerTeamIds.length === 0 ? (
                  <p className="min-w-0 flex-1 text-muted-foreground text-xs">
                    Making a Team the owner hands this file over: the Team's admins take charge of
                    it and you stop being its owner.
                  </p>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || chosen === undefined}
                  onClick={() => {
                    if (chosen === undefined) return;
                    void run(
                      (current) =>
                        proposeTeamAssetOperation("file", fileId, {
                          action: "add_owner",
                          teamId: chosen.id,
                          revision: current.revision,
                        }).then(() => undefined),
                      "Ownership change requested."
                    );
                  }}
                >
                  Make owner
                </Button>
                <Button type="submit" size="sm" disabled={busy || chosen === undefined}>
                  {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                  Share with Team
                </Button>
              </div>
            </form>
          ) : null}

          {ownership.shares.length === 0 ? (
            <p className="rounded-sm border border-border border-dashed px-3 py-4 text-muted-foreground text-sm">
              No Team can reach this file.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-sm border border-border">
              {ownership.shares.map((share) => (
                <li key={share.teamId} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <TeamAvatar identity={slugFor(share.teamId)} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">{nameFor(share.teamId)}</p>
                    <p className="truncate text-muted-foreground text-xs">Team</p>
                  </div>
                  <Badge variant="info">{levelLabel(share.access)}</Badge>
                  {canManage ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={`Revoke access for ${nameFor(share.teamId)}`}
                      onClick={() =>
                        void run(
                          (current) =>
                            updateTeamAssetShares(
                              "file",
                              fileId,
                              current.shares.filter((held) => held.teamId !== share.teamId),
                              current.revision
                            ).then(() => undefined),
                          "Team sharing updated."
                        )
                      }
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                      Revoke
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
