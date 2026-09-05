import type { Team, TeamAssetAccessLevel } from "@tulipfarm/schema";
import { useEffect, useRef, useState } from "react";
import { OwnershipApprovalList } from "~/components/approvals/ownership-approval-list";
import { FormStatus } from "~/components/form-status";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Link } from "~/components/ui/link";
import { Modal } from "~/components/ui/modal";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { Select } from "~/components/ui/select";
import { ApiError } from "~/lib/api";
import {
  listTeamAssets,
  proposeTeamAssetOperation,
  type TeamAssetCatalogItem,
  type TeamAssetLifecycleStatus,
  type TeamAssetSectionCatalog,
  type TeamAssetSource,
  type TeamDirectoryEntry,
  updateTeamAssetShares,
} from "~/lib/teams";

export type TeamAssetSection = "agents" | "skills" | "routines" | "files" | "knowledge";
type Loadable<T> = { ok: true; value: T } | { ok: false; message: string };
type FilterValue<T extends string> = T | "all";

export function TeamAssetsPanel({
  section,
  team,
  teams,
  initialAssets,
  canCreate,
  isCompanyAdmin,
  onChanged,
}: {
  section: TeamAssetSection;
  team: Team;
  teams: TeamDirectoryEntry[];
  initialAssets: Loadable<TeamAssetSectionCatalog>;
  canCreate: boolean;
  isCompanyAdmin: boolean;
  onChanged: () => void;
}) {
  const type = assetTypeFor(section);
  const label = sectionLabel(section);
  const [source, setSource] = useState<FilterValue<TeamAssetSource>>("all");
  const [access, setAccess] = useState<FilterValue<TeamAssetAccessLevel>>("all");
  const [owner, setOwner] = useState("all");
  const [lifecycleStatus, setLifecycleStatus] =
    useState<FilterValue<TeamAssetLifecycleStatus>>("all");
  const [catalog, setCatalog] = useState<TeamAssetSectionCatalog>(() =>
    initialAssets.ok
      ? {
          items: initialAssets.value.items.filter((item) => item.assetType === type),
          nextCursor: initialAssets.value.nextCursor,
          blockers: [],
        }
      : { items: [], nextCursor: null, blockers: [] }
  );
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [shareTeamId, setShareTeamId] = useState(team.id);
  const [shareAccess, setShareAccess] = useState<TeamAssetAccessLevel>("view");
  const [singleShare, setSingleShare] = useState<TeamAssetCatalogItem | null>(null);
  const [ownerProposal, setOwnerProposal] = useState<TeamAssetCatalogItem | null>(null);
  const [notice, setNotice] = useState<{ tone: "error" | "success"; message: string } | null>(
    initialAssets.ok ? null : { tone: "error", message: initialAssets.message }
  );
  const initialLoad = useRef(true);

  useEffect(() => {
    if (initialLoad.current) {
      initialLoad.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    setSelected([]);
    void listTeamAssets({
      teamId: team.id,
      type,
      ...(source === "all" ? {} : { source }),
      ...(access === "all" ? {} : { access }),
      ...(owner === "all" ? {} : { ownerTeamId: owner }),
      ...(lifecycleStatus === "all" ? {} : { lifecycleStatus }),
      limit: 25,
    })
      .then((next) => {
        if (cancelled) return;
        setCatalog(next);
        setNotice(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setCatalog({ items: [], nextCursor: null, blockers: [] });
        setNotice({ tone: "error", message: message(error, "Could not load Team assets.") });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [access, lifecycleStatus, owner, source, team.id, type]);

  async function refresh() {
    const next = await listTeamAssets({
      teamId: team.id,
      type,
      ...(source === "all" ? {} : { source }),
      ...(access === "all" ? {} : { access }),
      ...(owner === "all" ? {} : { ownerTeamId: owner }),
      ...(lifecycleStatus === "all" ? {} : { lifecycleStatus }),
      limit: 25,
    });
    setCatalog(next);
    setSelected([]);
    onChanged();
  }

  async function loadMore() {
    if (!catalog.nextCursor) return;
    setLoading(true);
    setNotice(null);
    try {
      const next = await listTeamAssets({
        teamId: team.id,
        type,
        ...(source === "all" ? {} : { source }),
        ...(access === "all" ? {} : { access }),
        ...(owner === "all" ? {} : { ownerTeamId: owner }),
        ...(lifecycleStatus === "all" ? {} : { lifecycleStatus }),
        cursor: catalog.nextCursor,
        limit: 25,
      });
      setCatalog({
        items: [...catalog.items, ...next.items],
        nextCursor: next.nextCursor,
        blockers: [],
      });
    } catch (error) {
      setNotice({ tone: "error", message: message(error, "Could not load more Team assets.") });
    } finally {
      setLoading(false);
    }
  }

  async function share(
    items: TeamAssetCatalogItem[],
    targetTeamId: string,
    level: TeamAssetAccessLevel
  ) {
    setNotice(null);
    try {
      await Promise.all(
        items.map((item) => {
          if (!item.ownership) {
            throw new Error("Ownership details are restricted for this asset.");
          }
          return updateTeamAssetShares(
            item.assetType,
            item.id,
            upsertShare(item.ownership.shares, targetTeamId, level),
            item.ownership.revision
          );
        })
      );
      setSingleShare(null);
      setNotice({ tone: "success", message: "Team sharing updated." });
      await refresh();
    } catch (error) {
      throw new Error(message(error, "Could not update sharing."));
    }
  }

  async function propose(
    item: TeamAssetCatalogItem,
    action: "add_owner" | "remove_owner" | "archive" | "delete",
    teamId?: string
  ) {
    setNotice(null);
    try {
      await proposeTeamAssetOperation(item.assetType, item.id, {
        action,
        ...(teamId ? { teamId } : {}),
        revision: item.ownership?.revision ?? 0,
      });
      setOwnerProposal(null);
      setNotice({ tone: "success", message: "Ownership Approval requested." });
      await refresh();
    } catch (error) {
      setNotice({ tone: "error", message: message(error, "Could not request Approval.") });
    }
  }

  async function proposeOwner(item: TeamAssetCatalogItem, teamId: string) {
    try {
      await proposeTeamAssetOperation(item.assetType, item.id, {
        action: "add_owner",
        teamId,
        revision: item.ownership?.revision ?? 0,
      });
      setOwnerProposal(null);
      setNotice({ tone: "success", message: "Ownership Approval requested." });
      await refresh();
    } catch (error) {
      throw new Error(message(error, "Could not request Approval."));
    }
  }

  const selectedRows = catalog.items.filter((item) => selected.includes(assetKey(item)));

  return (
    <Panel
      title={label}
      description={`${label} this Team owns, inherits, or can reach through sharing.`}
      actions={
        canCreate ? (
          <Link
            to={createPromptHref(type, team)}
            className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-sm"
          >
            Create {assetNoun(type)}
          </Link>
        ) : null
      }
    >
      <div className="space-y-4">
        <AssetFilters
          teams={teams}
          source={source}
          access={access}
          owner={owner}
          status={lifecycleStatus}
          onSource={setSource}
          onAccess={setAccess}
          onOwner={setOwner}
          onStatus={setLifecycleStatus}
        />
        {notice ? <FormStatus tone={notice.tone}>{notice.message}</FormStatus> : null}
        {selectedRows.length > 0 ? (
          <BulkShareBar
            teams={teams}
            shareTeamId={shareTeamId}
            shareAccess={shareAccess}
            count={selectedRows.length}
            onTeam={setShareTeamId}
            onAccess={setShareAccess}
            onShare={() => {
              void share(selectedRows, shareTeamId, shareAccess).catch((error) =>
                setNotice({ tone: "error", message: error.message })
              );
            }}
          />
        ) : null}
        {catalog.items.length === 0 ? (
          <PanelEmpty>
            {loading
              ? `Loading ${label.toLocaleLowerCase()}…`
              : `No ${label.toLocaleLowerCase()} match these filters.`}
          </PanelEmpty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-border border-b text-muted-foreground text-xs">
                <tr>
                  <th className="w-10 p-2">Select</th>
                  <th className="p-2">Asset</th>
                  <th className="p-2">Source</th>
                  <th className="p-2">Access</th>
                  <th className="p-2">Owners</th>
                  <th className="p-2">Approvals</th>
                  <th className="p-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {catalog.items.map((item) => (
                  <AssetRow
                    key={assetKey(item)}
                    item={item}
                    teams={teams}
                    isCompanyAdmin={isCompanyAdmin}
                    checked={selected.includes(assetKey(item))}
                    onChecked={(checked) =>
                      setSelected((current) =>
                        checked
                          ? [...current, assetKey(item)]
                          : current.filter((key) => key !== assetKey(item))
                      )
                    }
                    onShare={() => setSingleShare(item)}
                    onAddOwner={() => setOwnerProposal(item)}
                    onOperation={(action, teamId) => void propose(item, action, teamId)}
                    onChanged={() => void refresh()}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {catalog.nextCursor ? (
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => void loadMore()}
          >
            {loading ? "Loading…" : "Load more"}
          </Button>
        ) : null}
      </div>
      <ShareAssetDialog
        item={singleShare}
        teams={teams}
        onClose={() => setSingleShare(null)}
        onShare={share}
      />
      <AddOwnerDialog
        item={ownerProposal}
        teams={teams}
        onClose={() => setOwnerProposal(null)}
        onPropose={proposeOwner}
      />
    </Panel>
  );
}

function AssetFilters({
  teams,
  source,
  access,
  owner,
  status,
  onSource,
  onAccess,
  onOwner,
  onStatus,
}: {
  teams: TeamDirectoryEntry[];
  source: FilterValue<TeamAssetSource>;
  access: FilterValue<TeamAssetAccessLevel>;
  owner: string;
  status: FilterValue<TeamAssetLifecycleStatus>;
  onSource: (value: FilterValue<TeamAssetSource>) => void;
  onAccess: (value: FilterValue<TeamAssetAccessLevel>) => void;
  onOwner: (value: string) => void;
  onStatus: (value: FilterValue<TeamAssetLifecycleStatus>) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Field label="Source">
        <Select
          value={source}
          onChange={(event) => onSource(event.target.value as FilterValue<TeamAssetSource>)}
        >
          <option value="all">Any source</option>
          <option value="owned">Owned</option>
          <option value="inherited">Inherited</option>
          <option value="shared">Shared</option>
        </Select>
      </Field>
      <Field label="Access level">
        <Select
          value={access}
          onChange={(event) => onAccess(event.target.value as FilterValue<TeamAssetAccessLevel>)}
        >
          <option value="all">Any access</option>
          <option value="view">View</option>
          <option value="use">Use</option>
          <option value="edit">Edit</option>
        </Select>
      </Field>
      <Field label="Owner Team">
        <Select value={owner} onChange={(event) => onOwner(event.target.value)}>
          <option value="all">Any owner</option>
          {teams.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.displayName}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Lifecycle status">
        <Select
          value={status}
          onChange={(event) =>
            onStatus(event.target.value as FilterValue<TeamAssetLifecycleStatus>)
          }
        >
          <option value="all">Any status</option>
          <option value="active">Active</option>
          <option value="pending">Pending Approval</option>
          <option value="archived">Archived</option>
        </Select>
      </Field>
    </div>
  );
}

function BulkShareBar({
  teams,
  shareTeamId,
  shareAccess,
  count,
  onTeam,
  onAccess,
  onShare,
}: {
  teams: TeamDirectoryEntry[];
  shareTeamId: string;
  shareAccess: TeamAssetAccessLevel;
  count: number;
  onTeam: (value: string) => void;
  onAccess: (value: TeamAssetAccessLevel) => void;
  onShare: () => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-muted/30 p-3">
      <Field label="Share selected with" className="min-w-48">
        <Select value={shareTeamId} onChange={(event) => onTeam(event.target.value)}>
          {teams
            .filter((team) => team.status === "active")
            .map((team) => (
              <option key={team.id} value={team.id}>
                {team.displayName}
              </option>
            ))}
        </Select>
      </Field>
      <Field label="Share access level" className="w-36">
        <Select
          value={shareAccess}
          onChange={(event) => onAccess(event.target.value as TeamAssetAccessLevel)}
        >
          <option value="view">View</option>
          <option value="use">Use</option>
          <option value="edit">Edit</option>
        </Select>
      </Field>
      <Button type="button" onClick={onShare}>
        Share selected ({count})
      </Button>
      <p className="basis-full text-xs text-muted-foreground">
        Bulk action changes sharing only. Ownership changes use Approvals per asset.
      </p>
    </div>
  );
}

function AssetRow({
  item,
  teams,
  isCompanyAdmin,
  checked,
  onChecked,
  onShare,
  onAddOwner,
  onOperation,
  onChanged,
}: {
  item: TeamAssetCatalogItem;
  teams: TeamDirectoryEntry[];
  isCompanyAdmin: boolean;
  checked: boolean;
  onChecked: (checked: boolean) => void;
  onShare: () => void;
  onAddOwner: () => void;
  onOperation: (action: "remove_owner" | "delete" | "archive", teamId?: string) => void;
  onChanged: () => void;
}) {
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const teamOwners =
    item.ownership?.owners.filter(
      (owner): owner is { kind: "team"; teamId: string } => owner.kind === "team"
    ) ?? [];
  const personalOwner = item.ownership?.owners.find((owner) => owner.kind === "principal");
  const canEdit = item.effectiveLevels.includes("edit");

  return (
    <tr className="border-border border-b align-top last:border-b-0">
      <td className="p-2">
        <input
          type="checkbox"
          aria-label={`Select ${item.label}`}
          checked={checked}
          disabled={!item.ownership || !item.canManageOwnership}
          onChange={(event) => onChecked(event.target.checked)}
        />
      </td>
      <td className="min-w-56 p-2">
        {item.href ? (
          <Link to={item.href} className="font-medium hover:underline">
            {item.label}
          </Link>
        ) : (
          <span className="font-medium">{item.label}</span>
        )}
        {item.description ? (
          <p className="mt-1 text-muted-foreground text-xs">{item.description}</p>
        ) : null}
        <Badge variant={item.lifecycleStatus === "archived" ? "neutral" : "primary"}>
          {item.lifecycleStatus}
        </Badge>
      </td>
      <td className="p-2">
        <Badge variant={item.source === "owned" ? "primary" : "neutral"}>{item.source}</Badge>
        <p className="mt-1 text-muted-foreground text-xs">
          {item.sourceTeamIds
            .map((teamId) => teamById.get(teamId)?.displayName ?? teamId)
            .join(", ")}
        </p>
      </td>
      <td className="p-2">
        <p className="flex flex-wrap gap-1">
          {item.effectiveLevels.length === 0 ? (
            <Badge variant="neutral">No access</Badge>
          ) : (
            item.effectiveLevels.map((level) => (
              <Badge key={level} variant={level === "edit" ? "success" : "neutral"}>
                {accessLabel(level)}
              </Badge>
            ))
          )}
        </p>
        <p className="mt-1 max-w-48 text-muted-foreground text-xs">
          {item.canManageOwnership
            ? "The server grants ownership management."
            : "Ownership management is not granted."}
        </p>
      </td>
      <td className="p-2">
        <p>
          {!item.ownership
            ? "Ownership details restricted"
            : teamOwners.length > 0
              ? teamOwners
                  .map((owner) => teamById.get(owner.teamId)?.displayName ?? owner.teamId)
                  .join(", ")
              : "No Team owners"}
        </p>
        {personalOwner ? (
          <p className="text-muted-foreground text-xs">
            Personal owner: {personalOwner.principalId}
          </p>
        ) : null}
      </td>
      <td className="min-w-56 p-2">
        {item.ownership ? (
          <OwnershipApprovalList
            approvals={item.approvals}
            isCompanyAdmin={isCompanyAdmin}
            onChanged={onChanged}
          />
        ) : (
          <span className="text-muted-foreground text-xs">Approval details restricted</span>
        )}
      </td>
      <td className="space-y-2 p-2">
        <div className="flex min-w-48 flex-wrap gap-2">
          {item.href && canEdit ? (
            <Link to={item.href} className="rounded-md border border-border px-2 py-1 text-xs">
              Edit
            </Link>
          ) : null}
          {item.ownership && item.canManageOwnership ? (
            <>
              <Button
                type="button"
                variant="outline"
                aria-label={`Share ${item.label}`}
                onClick={onShare}
              >
                Share
              </Button>
              <Button
                type="button"
                variant="outline"
                aria-label={`Propose add owner for ${item.label}`}
                onClick={onAddOwner}
              >
                Propose add owner
              </Button>
              {teamOwners.map((owner) => (
                <Button
                  key={owner.teamId}
                  type="button"
                  variant="outline"
                  aria-label={`Propose removing ${
                    teamById.get(owner.teamId)?.displayName ?? owner.teamId
                  } from ${item.label}`}
                  onClick={() => onOperation("remove_owner", owner.teamId)}
                >
                  Propose removing {teamById.get(owner.teamId)?.displayName ?? owner.teamId}
                </Button>
              ))}
              <Button
                type="button"
                variant="outline"
                aria-label={`Propose archive for ${item.label}`}
                onClick={() => onOperation("archive")}
              >
                Propose archive
              </Button>
              <Button
                type="button"
                variant="destructive"
                aria-label={`Propose delete for ${item.label}`}
                onClick={() => onOperation("delete")}
              >
                Propose delete
              </Button>
            </>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function ShareAssetDialog({
  item,
  teams,
  onClose,
  onShare,
}: {
  item: TeamAssetCatalogItem | null;
  teams: TeamDirectoryEntry[];
  onClose: () => void;
  onShare: (
    items: TeamAssetCatalogItem[],
    targetTeamId: string,
    access: TeamAssetAccessLevel
  ) => Promise<void>;
}) {
  const [targetTeamId, setTargetTeamId] = useState("");
  const [access, setAccess] = useState<TeamAssetAccessLevel>("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!item) return;
    if (!targetTeamId) {
      setError("Choose a target Team.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onShare([item], targetTeamId, access);
      setTargetTeamId("");
      setAccess("view");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update sharing.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={item !== null} onClose={onClose} title={`Share ${item?.label ?? "asset"}`}>
      <p className="text-sm text-muted-foreground">
        Choose the exact Team and access level. Existing shares for other Teams stay unchanged.
      </p>
      <div className="mt-4 space-y-4">
        <Field label="Target Team" required>
          <Select value={targetTeamId} onChange={(event) => setTargetTeamId(event.target.value)}>
            <option value="">Choose a Team…</option>
            {teams
              .filter((team) => team.status === "active")
              .map((team) => (
                <option key={team.id} value={team.id}>
                  {team.displayName}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Access level" required>
          <Select
            value={access}
            onChange={(event) => setAccess(event.target.value as TeamAssetAccessLevel)}
          >
            <option value="view">View</option>
            <option value="use">Use</option>
            <option value="edit">Edit</option>
          </Select>
        </Field>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void submit()} disabled={busy}>
          {busy ? "Sharing…" : "Share asset"}
        </Button>
      </div>
    </Modal>
  );
}

function AddOwnerDialog({
  item,
  teams,
  onClose,
  onPropose,
}: {
  item: TeamAssetCatalogItem | null;
  teams: TeamDirectoryEntry[];
  onClose: () => void;
  onPropose: (item: TeamAssetCatalogItem, teamId: string) => Promise<void>;
}) {
  const [teamId, setTeamId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ownerIds = new Set(
    item?.ownership?.owners.flatMap((owner) => (owner.kind === "team" ? [owner.teamId] : [])) ?? []
  );

  async function submit() {
    if (!item) return;
    if (!teamId) {
      setError("Choose an active Team.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onPropose(item, teamId);
      setTeamId("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not request Approval.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={item !== null}
      onClose={onClose}
      title={`Add an owner to ${item?.label ?? "asset"}`}
    >
      <p className="text-sm text-muted-foreground">
        Every current owning Team and the proposed Team must approve this change.
      </p>
      <div className="mt-4">
        <Field label="New owning Team" required>
          <Select value={teamId} onChange={(event) => setTeamId(event.target.value)}>
            <option value="">Choose an active Team…</option>
            {teams
              .filter((team) => team.status === "active" && !ownerIds.has(team.id))
              .map((team) => (
                <option key={team.id} value={team.id}>
                  {team.displayName}
                </option>
              ))}
          </Select>
        </Field>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void submit()} disabled={busy}>
          {busy ? "Requesting…" : "Request owner Approval"}
        </Button>
      </div>
    </Modal>
  );
}

function assetTypeFor(section: TeamAssetSection): TeamAssetCatalogItem["assetType"] {
  if (section === "agents") return "agent";
  if (section === "skills") return "skill";
  if (section === "routines") return "routine";
  if (section === "files") return "file";
  return "knowledge";
}

function sectionLabel(section: TeamAssetSection): string {
  if (section === "agents") return "Agents";
  if (section === "skills") return "Skills";
  if (section === "routines") return "Routines";
  if (section === "files") return "Files";
  return "Knowledge";
}

function assetKey(item: TeamAssetCatalogItem): string {
  return `${item.assetType}:${item.id}`;
}

function upsertShare(
  shares: NonNullable<TeamAssetCatalogItem["ownership"]>["shares"],
  teamId: string,
  access: TeamAssetAccessLevel
) {
  return [...shares.filter((share) => share.teamId !== teamId), { teamId, access }];
}

function accessLabel(access: TeamAssetAccessLevel): string {
  if (access === "edit") return "Edit";
  if (access === "use") return "Use";
  return "View";
}

function assetNoun(type: TeamAssetCatalogItem["assetType"]): string {
  if (type === "knowledge") return "Knowledge";
  return type[0]?.toLocaleUpperCase() + type.slice(1);
}

function createPromptHref(type: TeamAssetCatalogItem["assetType"], team: Team): string {
  return `/?prompt=${encodeURIComponent(
    `Create a ${assetNoun(type)} owned by ${team.displayName}. Preselect ${team.displayName} as owner and ask whether to add more owning Teams.`
  )}`;
}

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}
