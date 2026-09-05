import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  redirect,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "@remix-run/react";
import { type FormEvent, useMemo, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Field, ReadonlyField } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import { Panel } from "~/components/ui/panel";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { ApiError } from "~/lib/api";
import { createTeam, listTeams, parseTeamLabels } from "~/lib/teams";
import { useIsAdmin } from "~/lib/use-session-user";
import { listUsers } from "~/lib/users";

export const meta: MetaFunction = () => [{ title: "Create Team · tulipfarm" }];

export async function clientLoader({ request }: ClientLoaderFunctionArgs) {
  if (new URL(request.url).pathname !== "/teams/new") throw redirect("/teams/new");
  const [{ teams }, users] = await Promise.all([listTeams(), listUsers()]);
  return { teams, users: users.filter((user) => user.status === "active") };
}

export default function CreateTeamRoute() {
  const { teams, users } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const isAdmin = useIsAdmin();
  const [displayName, setDisplayName] = useState("");
  const [parentTeamId, setParentTeamId] = useState(
    teams.find((team) => team.slug === "everyone")?.id ?? teams[0]?.id ?? ""
  );
  const [description, setDescription] = useState("");
  const [labels, setLabels] = useState("");
  const [adminIds, setAdminIds] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const slug = teamSlug(displayName);
  const conflicts = useMemo(
    () => creationConflicts(teams, displayName, slug, parentTeamId),
    [teams, displayName, slug, parentTeamId]
  );

  if (!isAdmin) {
    return (
      <FormStatus tone="error">
        Only a company admin can create a Team. The server will check this permission again.
      </FormStatus>
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setServerError(null);
    if (!displayName.trim() || !slug || !parentTeamId || adminIds.length === 0 || conflicts) return;

    setBusy(true);
    try {
      const team = await createTeam({
        displayName: displayName.trim(),
        slug,
        parentTeamId,
        description: description.trim() || undefined,
        labels: parseTeamLabels(labels),
        initialAdminUserIds: adminIds,
      });
      navigate(`/teams/${encodeURIComponent(team.slug)}`);
    } catch (error) {
      setServerError(teamErrorMessage(error, "Could not create this Team."));
    } finally {
      setBusy(false);
    }
  }

  function toggleAdmin(userId: string) {
    setAdminIds((current) =>
      current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId]
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link to="/teams" className="text-sm text-muted-foreground hover:text-foreground">
        ← Teams
      </Link>
      <Panel
        title="Create Team"
        description="Choose the Team's place in the company and at least one person to administer it."
      >
        <form className="space-y-5" onSubmit={submit} noValidate>
          <Field
            label="Display name"
            required
            error={submitted && !displayName.trim() ? "Enter a Team name." : conflicts?.displayName}
          >
            <Input
              value={displayName}
              maxLength={256}
              autoFocus
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Field>

          <dl>
            <ReadonlyField label="Immutable slug">
              <code>{slug || "generated-from-name"}</code>
              {conflicts?.slug ? (
                <span className="mt-1 block text-xs text-destructive">{conflicts.slug}</span>
              ) : (
                <span className="mt-1 block text-xs text-muted-foreground">
                  Generated once. It cannot be changed later.
                </span>
              )}
            </ReadonlyField>
          </dl>

          <Field
            label="Parent Team"
            required
            error={submitted && !parentTeamId ? "Choose a parent Team." : undefined}
          >
            <Select value={parentTeamId} onChange={(event) => setParentTeamId(event.target.value)}>
              <option value="">Choose a Team</option>
              {teams
                .filter((team) => team.status === "active")
                .map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.displayName}
                  </option>
                ))}
            </Select>
          </Field>

          <Field label="Description" help="Optional. Visible to everyone in the company.">
            <Textarea
              value={description}
              maxLength={2000}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>

          <Field
            label="Labels"
            help="Optional. Separate labels with commas, for example engineering, infrastructure."
          >
            <Input
              value={labels}
              maxLength={500}
              placeholder="engineering, infrastructure"
              onChange={(event) => setLabels(event.target.value)}
            />
          </Field>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-foreground">
              Initial human Team admins <span className="text-muted-foreground">*</span>
            </legend>
            <p className="text-xs text-muted-foreground">
              The creator is not selected automatically.
            </p>
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-2">
              {users.map((user) => (
                <label
                  key={user.id}
                  htmlFor={`team-admin-${user.id}`}
                  className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-accent"
                >
                  <Checkbox
                    id={`team-admin-${user.id}`}
                    checked={adminIds.includes(user.id)}
                    onChange={() => toggleAdmin(user.id)}
                  />
                  <span className="text-sm">{user.name ?? user.email}</span>
                </label>
              ))}
              {users.length === 0 ? (
                <p className="px-2 py-3 text-sm text-muted-foreground">
                  No active people are available.
                </p>
              ) : null}
            </div>
            {submitted && adminIds.length === 0 ? (
              <p className="text-xs text-destructive">Select at least one human Team admin.</p>
            ) : null}
          </fieldset>

          {serverError ? <FormStatus tone="error">{serverError}</FormStatus> : null}
          <div className="flex justify-end gap-2">
            <Button asChild variant="outline">
              <Link to="/teams">Cancel</Link>
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create Team"}
            </Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}

export function teamSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128)
    .replace(/-+$/g, "");
}

function creationConflicts(
  teams: Awaited<ReturnType<typeof listTeams>>["teams"],
  displayName: string,
  slug: string,
  parentTeamId: string
): { displayName?: string; slug?: string } | null {
  const normalizedName = displayName.trim().toLocaleLowerCase();
  const displayNameConflict =
    normalizedName &&
    teams.some(
      (team) =>
        team.parentTeamId === parentTeamId &&
        team.displayName.trim().toLocaleLowerCase() === normalizedName
    );
  const slugConflict = slug && teams.some((team) => team.slug === slug);
  if (!displayNameConflict && !slugConflict) return null;
  return {
    ...(displayNameConflict
      ? { displayName: "A sibling Team already uses this display name." }
      : {}),
    ...(slugConflict ? { slug: "This business already uses or reserved this Team slug." } : {}),
  };
}

function teamErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function ErrorBoundary() {
  return (
    <FormStatus tone="error">
      {teamErrorMessage(useRouteError(), "Could not load Team creation.")}
    </FormStatus>
  );
}
