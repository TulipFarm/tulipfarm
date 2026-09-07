import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useRevalidator,
  useRouteError,
  useSearchParams,
} from "@remix-run/react";
import { useEffect, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { ErrorState } from "~/components/states";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Combobox } from "~/components/ui/combobox";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Panel } from "~/components/ui/panel";
import { ApiError } from "~/lib/api";
import {
  approveOimConnectionOrigin,
  authorizeOimConnection,
  createOimConnection,
  getOimConnections,
  type OimAuthorizationAction,
  type OimConnectForm,
  type OimConnectionSummary,
  revokeOimConnection,
  testOimConnection,
  updateOimConnection,
} from "~/lib/integrations";
import { usePublishPageTitle } from "~/lib/page-chrome-context";
import { listTeams, type TeamDirectoryEntry } from "~/lib/teams";
import { useIsAdmin } from "~/lib/use-session-user";

export const meta: MetaFunction = () => [{ title: "Connect integration · tulipfarm" }];

/**
 * The connect screen an Agent's `connection_required` answer points a person at.
 *
 * The path is fixed by that answer (`/business/integrations/{slug}/connections`), which is written
 * into Run transcripts — moving it would make every past Run's instruction wrong.
 */
export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const slug = params.slug;
  if (!slug) throw new ApiError(404, "missing integration name");
  const [{ form, connections }, { teams }] = await Promise.all([
    getOimConnections(slug),
    listTeams(),
  ]);
  return { slug, form, connections, teams };
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "Only an admin can create a shared connection for the business.";
    return err.message;
  }
  return err instanceof Error ? err.message : "Request failed.";
}

function blankValues(form: OimConnectForm): Record<string, string> {
  const values: Record<string, string> = {};
  for (const step of form.steps) {
    for (const field of step.fields) values[field.id] = "";
  }
  return values;
}

function healthLabel(health: string): string {
  switch (health) {
    case "healthy":
      return "Working";
    case "expiring":
      return "Expires soon";
    case "action_required":
      return "Reconnect needed";
    default:
      return "Needs attention";
  }
}

function fieldHelp(
  field: OimConnectForm["steps"][number]["fields"][number],
  updating = false
): string | undefined {
  const approval = field.requiresOriginApproval
    ? updating
      ? "Changing this host removes its prior approval. Approve the exact origin again after saving."
      : "After saving, approve the exact public HTTPS origin before Agents can use it."
    : undefined;
  return [field.description, approval].filter(Boolean).join(" ") || undefined;
}

function canonicalOrigin(value: string): string {
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).origin;
  } catch {
    return value;
  }
}

function handoff(action: OimAuthorizationAction): void {
  if (action.action === "redirect") {
    window.location.assign(action.url);
    return;
  }
  const form = document.createElement("form");
  form.method = "POST";
  form.action = action.url;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = action.field;
  input.value = action.value;
  form.append(input);
  document.body.append(form);
  form.submit();
}

function ConnectionRow({
  connection,
  slug,
  form,
  onChanged,
  teams,
  isAdmin,
}: {
  connection: OimConnectionSummary;
  slug: string;
  form: OimConnectForm;
  onChanged: () => void;
  teams: readonly TeamDirectoryEntry[];
  isAdmin: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState(connection.status);
  const [health, setHealth] = useState(connection.health);
  const [editingCredentials, setEditingCredentials] = useState(false);
  const [editingAccess, setEditingAccess] = useState(false);
  const [values, setValues] = useState(() => blankValues(form));
  const [connectionId, setConnectionId] = useState(connection.id);
  const [approvedOriginFields, setApprovedOriginFields] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [approvingOrigin, setApprovingOrigin] = useState<string>();
  const [scope, setScope] = useState(connection.scope);
  const [teamId, setTeamId] = useState(connection.teamId ?? "");
  const currentTeam = teams.find((team) => team.id === connection.teamId);
  const [teamChoice, setTeamChoice] = useState(
    currentTeam ? `${currentTeam.displayName} — ${currentTeam.slug}` : ""
  );
  const visible = Object.entries(connection.configuration);
  const teamChoices = teams.map((team) => `${team.displayName} — ${team.slug}`);
  const hasFields = form.steps.some((step) => step.fields.length > 0);
  const authorizationNeeded = status === "pending" && form.authorizationSteps.length > 0;
  const originApprovals = form.steps.flatMap((step) =>
    step.fields.flatMap((field) => {
      const value = connection.configuration[field.id];
      return field.requiresOriginApproval &&
        typeof value === "string" &&
        !approvedOriginFields.has(field.id)
        ? [{ field, origin: canonicalOrigin(value) }]
        : [];
    })
  );

  useEffect(() => {
    setConnectionId(connection.id);
    setStatus(connection.status);
    setHealth(connection.health);
  }, [connection.id, connection.status, connection.health]);

  async function approveOrigin(field: string) {
    setApprovingOrigin(field);
    setError(null);
    try {
      const updated = await approveOimConnectionOrigin(slug, connectionId, field);
      setConnectionId(updated.id);
      setStatus(updated.status);
      setHealth(updated.health);
      setApprovedOriginFields((current) => new Set(current).add(field));
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setApprovingOrigin(undefined);
    }
  }

  async function beginAuthorization() {
    setBusy(true);
    setError(null);
    try {
      const action = await authorizeOimConnection(slug, connectionId);
      handoff(action);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  async function saveCredentials(event: React.FormEvent) {
    event.preventDefault();
    const changed = Object.fromEntries(
      Object.entries(values).filter(([, value]) => value.trim().length > 0)
    );
    if (Object.keys(changed).length === 0) {
      setError("Enter at least one new value.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const updated = await updateOimConnection(slug, connectionId, { values: changed });
      setConnectionId(updated.id);
      setStatus(updated.status);
      setHealth(updated.health);
      setApprovedOriginFields((current) => {
        const next = new Set(current);
        for (const field of Object.keys(changed)) next.delete(field);
        return next;
      });
      setValues(blankValues(form));
      setEditingCredentials(false);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveAccess(event: React.FormEvent) {
    event.preventDefault();
    if (scope === "team" && !teamId) {
      setError("Select a Team.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await updateOimConnection(slug, connectionId, {
        scope,
        ...(scope === "team" ? { teamId } : {}),
      });
      setConnectionId(updated.id);
      setStatus(updated.status);
      setHealth(updated.health);
      setApprovedOriginFields(new Set());
      setEditingAccess(false);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="space-y-3 px-4 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{connection.label}</span>
            <Badge>
              {connection.scope === "organization"
                ? "Business"
                : connection.scope === "team"
                  ? (teams.find((team) => team.id === connection.teamId)?.displayName ?? "Team")
                  : "Personal"}
            </Badge>
            {connection.isDefault ? <Badge>Default</Badge> : null}
            {status === "revoked" ? <Badge>Revoked</Badge> : null}
            {status === "pending" ? <Badge>Setup required</Badge> : null}
            {status === "active" && health !== "unknown" ? (
              <Badge>{healthLabel(health)}</Badge>
            ) : null}
          </div>
          {visible.length > 0 ? (
            <p className="truncate text-xs text-muted-foreground">
              {visible.map(([key, value]) => `${key}: ${value}`).join(" · ")}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        {status !== "revoked" ? (
          <div className="flex flex-wrap items-center gap-1">
            {authorizationNeeded ? (
              <Button variant="outline" disabled={busy} onClick={beginAuthorization}>
                Continue setup
              </Button>
            ) : null}
            <label className="flex min-h-7 items-center gap-2 rounded-md px-2 text-xs">
              <input
                type="checkbox"
                checked={connection.isDefault}
                disabled={busy}
                onChange={async (event) => {
                  setBusy(true);
                  setError(null);
                  try {
                    const updated = await updateOimConnection(slug, connectionId, {
                      isDefault: event.target.checked,
                    });
                    setConnectionId(updated.id);
                    setStatus(updated.status);
                    setHealth(updated.health);
                    onChanged();
                  } catch (err) {
                    setError(errorMessage(err));
                  } finally {
                    setBusy(false);
                  }
                }}
                className="size-4 accent-foreground"
              />
              Default
            </label>
            {hasFields ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setEditingCredentials((editing) => !editing)}
              >
                Rotate credentials
              </Button>
            ) : null}
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setEditingAccess((editing) => !editing)}
            >
              Change access
            </Button>
            {status === "active" ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    const result = await testOimConnection(slug, connectionId);
                    setHealth(result.status);
                    if (result.status !== "healthy") {
                      setError(
                        result.status === "action_required"
                          ? "The provider rejected these credentials. Rotate them or create a new Connection."
                          : "The provider did not answer. Try again in a moment."
                      );
                    }
                  } catch (err) {
                    setError(errorMessage(err));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Test
              </Button>
            ) : null}
            <Button
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await revokeOimConnection(slug, connectionId);
                  onChanged();
                } catch (err) {
                  setError(errorMessage(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Disconnect
            </Button>
          </div>
        ) : null}
      </div>

      {status !== "revoked" && health === "action_required" && originApprovals.length > 0 ? (
        <section className="space-y-3 rounded-md border border-border bg-muted/40 p-3">
          <div>
            <h3 className="text-sm font-medium">Approve public origin</h3>
            <p className="text-xs text-muted-foreground">
              Check the exact destination below. Approval applies only to this Connection and is
              removed when its host or access changes.
            </p>
          </div>
          {originApprovals.map(({ field, origin }) => (
            <div
              key={field.id}
              className="flex flex-col gap-2 rounded-md bg-background p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{field.label}</p>
                <code className="block break-all text-sm">{origin}</code>
              </div>
              <Button
                type="button"
                size="sm"
                disabled={approvingOrigin !== undefined}
                onClick={() => approveOrigin(field.id)}
                aria-label={`Approve ${origin}`}
              >
                {approvingOrigin === field.id ? "Approving…" : "Approve exact origin"}
              </Button>
            </div>
          ))}
        </section>
      ) : null}

      {editingCredentials ? (
        <form onSubmit={saveCredentials} className="space-y-3 rounded-md bg-muted/50 p-3">
          <p className="text-xs text-muted-foreground">
            Enter only values that changed. Existing credentials are never read back.
          </p>
          {form.steps.flatMap((step) =>
            step.fields.map((field) => (
              <Field
                key={`${step.id}:${field.id}`}
                label={field.label}
                help={fieldHelp(field, true)}
                htmlFor={`rotate-${connection.id}-${field.id}`}
              >
                <Input
                  id={`rotate-${connection.id}-${field.id}`}
                  name={field.id}
                  type={field.secret ? "password" : field.input === "url" ? "url" : "text"}
                  autoComplete="off"
                  aria-describedby={
                    field.description ? `rotate-${connection.id}-${field.id}-help` : undefined
                  }
                  value={values[field.id] ?? ""}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [field.id]: event.target.value }))
                  }
                />
              </Field>
            ))
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save new values"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setEditingCredentials(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {editingAccess ? (
        <form onSubmit={saveAccess} className="space-y-3 rounded-md bg-muted/50 p-3">
          <ScopePicker
            scope={scope}
            onScopeChange={setScope}
            isAdmin={isAdmin}
            name={`access-scope-${connection.id}`}
          />
          {scope === "team" ? (
            <Field label="Team" required htmlFor={`access-team-${connection.id}`}>
              <Combobox
                id={`access-team-${connection.id}`}
                value={teamChoice}
                options={teamChoices}
                placeholder="Select a Team"
                emptyLabel="No matching Team."
                onValueChange={setTeamChoice}
                onCommit={(value) => {
                  setTeamId(
                    teams.find((team) => `${team.displayName} — ${team.slug}` === value)?.id ?? ""
                  );
                }}
              />
            </Field>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Changing access creates a replacement Connection and revokes the old one.
          </p>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save access"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setEditingAccess(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </li>
  );
}

function ScopePicker({
  scope,
  onScopeChange,
  isAdmin,
  name = "connection-scope",
}: {
  scope: "personal" | "organization" | "team";
  onScopeChange: (scope: "personal" | "organization" | "team") => void;
  isAdmin: boolean;
  name?: string;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Used by</legend>
      {(
        [
          ["personal", "Just me"],
          ["organization", "The whole business"],
          ["team", "One Team"],
        ] as const
      ).map(([value, label]) => (
        <label key={value} className="flex min-h-7 items-center gap-2 text-sm">
          <input
            type="radio"
            name={name}
            value={value}
            checked={scope === value}
            disabled={value === "organization" && !isAdmin}
            onChange={() => onScopeChange(value)}
            className="size-4 accent-foreground"
          />
          <span>{label}</span>
        </label>
      ))}
      {!isAdmin ? (
        <p className="text-xs text-muted-foreground">
          Only an admin can add a Connection shared with the whole business.
        </p>
      ) : null}
    </fieldset>
  );
}

export default function IntegrationConnections() {
  const { slug, form, connections, teams } = useLoaderData<typeof clientLoader>();
  usePublishPageTitle("Connections");
  const isAdmin = useIsAdmin();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const [values, setValues] = useState(() => blankValues(form));
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<"personal" | "organization" | "team">("personal");
  const [teamId, setTeamId] = useState("");
  const [teamChoice, setTeamChoice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [createdStatus, setCreatedStatus] = useState<"active" | "pending">();
  const [isDefault, setIsDefault] = useState(connections.length === 0);
  const [callbackStatus, setCallbackStatus] = useState<{
    tone: "error" | "success";
    message: string;
  }>();

  const runnable =
    form.unsupportedStepTypes.length === 0 && (form.steps.length > 0 || form.requiresAuthorization);
  const requiresOriginApproval = form.steps.some((step) =>
    step.fields.some((field) => field.requiresOriginApproval)
  );
  const teamChoices = teams.map((team) => `${team.displayName} — ${team.slug}`);

  useEffect(() => {
    const status = searchParams.get("status");
    if (!status) return;
    setCallbackStatus({
      tone: status === "error" ? "error" : "success",
      message:
        status === "error"
          ? "The provider step did not complete. Try it again from the Connection below."
          : "Provider step completed. Continue setup if this Connection still needs authorization.",
    });
    revalidator.revalidate();
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("status");
        next.delete("reason");
        next.delete("nextStepId");
        return next;
      },
      { replace: true }
    );
  }, [searchParams, setSearchParams, revalidator]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (scope === "team" && !teamId) {
      setFormError("Select a Team.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    setCreatedStatus(undefined);
    try {
      const created = await createOimConnection(slug, {
        label,
        scope,
        ...(scope === "team" ? { teamId } : {}),
        values,
        isDefault,
      });
      setCreatedStatus(created.status);
      setValues(blankValues(form));
      setLabel("");
      revalidator.revalidate();
      const firstAuthorizationStep = form.authorizationSteps[0];
      if (created.status === "pending" && firstAuthorizationStep) {
        const action = await authorizeOimConnection(slug, created.connectionId, {
          stepId: firstAuthorizationStep.id,
        });
        handoff(action);
      }
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      {createdStatus === "active" ? (
        <FormStatus tone="success">
          Connected. Agents can use this integration from their next turn.
        </FormStatus>
      ) : createdStatus === "pending" ? (
        <FormStatus tone="success">
          {form.authorizationSteps.length > 0
            ? "Connection saved. Finish the remaining provider steps before Agents can use it."
            : requiresOriginApproval
              ? "Connection saved. Approve its exact public HTTPS origin before Agents can use it."
              : "Connection saved. More setup is required before Agents can use it."}
        </FormStatus>
      ) : null}
      {callbackStatus ? (
        <FormStatus tone={callbackStatus.tone}>{callbackStatus.message}</FormStatus>
      ) : null}

      <Panel
        title="Connections"
        description="Who this integration acts as. A personal connection spends only your own credential; a business one is shared with everyone who can use this integration."
        flush
      >
        {connections.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            Nothing is connected yet. Fill in the setup below to add the first connection.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {connections.map((connection) => (
              <ConnectionRow
                key={connection.id}
                connection={connection}
                slug={slug}
                form={form}
                onChanged={() => revalidator.revalidate()}
                teams={teams}
                isAdmin={isAdmin}
              />
            ))}
          </ul>
        )}
      </Panel>

      {runnable ? (
        <form onSubmit={onSubmit}>
          <Panel title="Add a connection" description={`Setup declared by the ${slug} package.`}>
            <div className="space-y-4 px-4 pb-4">
              <Field label="Name" required htmlFor="connection-label">
                <Input
                  id="connection-label"
                  value={label}
                  required
                  maxLength={128}
                  placeholder="Support desk"
                  onChange={(event) => setLabel(event.target.value)}
                />
              </Field>

              <ScopePicker scope={scope} onScopeChange={setScope} isAdmin={isAdmin} />
              {scope === "team" ? (
                <Field label="Team" required htmlFor="connection-team">
                  <Combobox
                    id="connection-team"
                    value={teamChoice}
                    options={teamChoices}
                    placeholder="Select a Team"
                    emptyLabel="No matching Team."
                    onValueChange={setTeamChoice}
                    onCommit={(value) => {
                      setTeamId(
                        teams.find((team) => `${team.displayName} — ${team.slug}` === value)?.id ??
                          ""
                      );
                    }}
                  />
                </Field>
              ) : null}

              {form.steps.map((step) => (
                <div key={step.id} className="space-y-4">
                  <div>
                    <h3 className="text-sm font-medium">{step.title}</h3>
                    {step.description ? (
                      <p className="text-xs text-muted-foreground">{step.description}</p>
                    ) : null}
                  </div>
                  {step.fields.map((field) => (
                    <Field
                      key={field.id}
                      label={field.label}
                      help={fieldHelp(field)}
                      required={field.required}
                      htmlFor={`field-${field.id}`}
                    >
                      <Input
                        id={`field-${field.id}`}
                        // A secret is written straight to the Secret store and never read back, so
                        // the browser must not offer to remember and re-fill it either.
                        type={field.secret ? "password" : field.input === "url" ? "url" : "text"}
                        autoComplete={field.secret ? "off" : undefined}
                        aria-describedby={field.description ? `field-${field.id}-help` : undefined}
                        required={field.required}
                        value={values[field.id] ?? ""}
                        onChange={(event) =>
                          setValues((current) => ({
                            ...current,
                            [field.id]: event.target.value,
                          }))
                        }
                      />
                    </Field>
                  ))}
                </div>
              ))}

              {form.authorizationSteps.length > 0 ? (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium">Provider steps</h3>
                  <ol className="space-y-2">
                    {form.authorizationSteps.map((step, index) => (
                      <li key={step.id} className="flex gap-2 text-sm">
                        <span className="text-muted-foreground tabular-nums">{index + 1}.</span>
                        <span>
                          <span className="font-medium">{step.title}</span>
                          {step.description ? (
                            <span className="block text-xs text-muted-foreground">
                              {step.description}
                            </span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}

              <label className="flex min-h-7 items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={isDefault}
                  onChange={(event) => setIsDefault(event.target.checked)}
                  className="mt-0.5 size-4 accent-foreground"
                />
                <span>
                  <span className="font-medium">Use as the default Connection</span>
                  <span className="block text-xs text-muted-foreground">
                    Agents use it when a request does not name another Connection.
                  </span>
                </span>
              </label>

              {formError ? <FormStatus tone="error">{formError}</FormStatus> : null}
              <Button type="submit" disabled={submitting}>
                {submitting
                  ? "Saving…"
                  : form.requiresAuthorization
                    ? "Save and continue"
                    : "Connect"}
              </Button>
            </div>
          </Panel>
        </form>
      ) : (
        <Panel title="Add a connection">
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            {form.unsupportedStepTypes.length > 0
              ? `This integration signs in with ${form.unsupportedStepTypes.join(", ")}, which this deployment cannot run yet.`
              : "This integration declares no setup, so there is nothing to connect."}
          </p>
        </Panel>
      )}
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  return (
    <ErrorState
      section="integration connections"
      {...(status === undefined ? {} : { status })}
      {...(error instanceof Error ? { message: error.message } : {})}
    />
  );
}
