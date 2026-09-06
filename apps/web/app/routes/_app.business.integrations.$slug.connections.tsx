import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useRevalidator,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { FormStatus } from "~/components/form-status";
import { ErrorState } from "~/components/states";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Combobox } from "~/components/ui/combobox";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Panel } from "~/components/ui/panel";
import { Select } from "~/components/ui/select";
import { ApiError } from "~/lib/api";
import {
  authorizeOimConnection,
  createOimConnection,
  getOimConnections,
  type OimConnectForm,
  type OimConnectionSummary,
  revokeOimConnection,
  testOimConnection,
} from "~/lib/integrations";
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

function ConnectionRow({
  connection,
  slug,
  requiresAuthorization,
  onRevoked,
  teams,
}: {
  connection: OimConnectionSummary;
  slug: string;
  requiresAuthorization: boolean;
  onRevoked: () => void;
  teams: readonly TeamDirectoryEntry[];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState(connection.health);
  const visible = Object.entries(connection.configuration);

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{connection.label}</span>
          <Badge>
            {connection.scope === "organization"
              ? "Business"
              : connection.scope === "team"
                ? (teams.find((team) => team.id === connection.teamId)?.displayName ?? "Team")
                : "Personal"}
          </Badge>
          {connection.status === "revoked" ? <Badge>Revoked</Badge> : null}
          {connection.status === "active" && health !== "unknown" ? (
            <Badge>{healthLabel(health)}</Badge>
          ) : null}
        </div>
        {visible.length > 0 ? (
          <p className="truncate text-xs text-muted-foreground">
            {visible.map(([key, value]) => `${key}: ${value}`).join(" · ")}
          </p>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
      {connection.status === "active" ? (
        <div className="flex items-center gap-1">
          {requiresAuthorization ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  // A full navigation, not a fetch: the provider's consent screen is a page the
                  // person has to see and act on, and some refuse to render in a frame.
                  const { url } = await authorizeOimConnection(slug, connection.id);
                  window.location.assign(url);
                } catch (err) {
                  setError(errorMessage(err));
                  setBusy(false);
                }
              }}
            >
              Authorize
            </Button>
          ) : null}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const result = await testOimConnection(slug, connection.id);
                setHealth(result.status);
                if (result.status !== "healthy") {
                  setError(
                    result.status === "action_required"
                      ? "The provider rejected these credentials. Disconnect and connect again."
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
          <Button
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await revokeOimConnection(slug, connection.id);
                onRevoked();
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
    </li>
  );
}

export default function IntegrationConnections() {
  const { slug, form, connections, teams } = useLoaderData<typeof clientLoader>();
  const isAdmin = useIsAdmin();
  const revalidator = useRevalidator();
  const [values, setValues] = useState(() => blankValues(form));
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<"personal" | "organization" | "team">("personal");
  const [teamId, setTeamId] = useState("");
  const [teamChoice, setTeamChoice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const runnable = form.unsupportedStepTypes.length === 0 && form.steps.length > 0;
  const teamChoices = teams.map((team) => `${team.displayName} — ${team.slug}`);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (scope === "team" && !teamId) {
      setFormError("Select a Team.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    setConnected(false);
    try {
      await createOimConnection(slug, {
        label,
        scope,
        ...(scope === "team" ? { teamId } : {}),
        values,
      });
      setConnected(true);
      setValues(blankValues(form));
      setLabel("");
      revalidator.revalidate();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      {connected ? (
        <FormStatus tone="success">
          Connected. Agents can use this integration from their next turn.
        </FormStatus>
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
                requiresAuthorization={form.requiresAuthorization}
                onRevoked={() => revalidator.revalidate()}
                teams={teams}
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

              <Field
                label="Used by"
                help={
                  isAdmin
                    ? undefined
                    : "Only an admin can add a connection shared with the whole business."
                }
                htmlFor="connection-scope"
              >
                <Select
                  id="connection-scope"
                  value={scope}
                  onChange={(event) =>
                    setScope(event.target.value as "personal" | "organization" | "team")
                  }
                >
                  <option value="personal">Just me</option>
                  <option value="organization" disabled={!isAdmin}>
                    The whole business
                  </option>
                  <option value="team">One Team</option>
                </Select>
              </Field>
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
                      help={field.description}
                      required={field.required}
                      htmlFor={`field-${field.id}`}
                    >
                      <Input
                        id={`field-${field.id}`}
                        // A secret is written straight to the Secret store and never read back, so
                        // the browser must not offer to remember and re-fill it either.
                        type={field.secret ? "password" : field.input === "url" ? "url" : "text"}
                        autoComplete={field.secret ? "off" : undefined}
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

              {formError ? <FormStatus tone="error">{formError}</FormStatus> : null}
              <Button type="submit" disabled={submitting}>
                {submitting ? "Connecting…" : "Connect"}
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
