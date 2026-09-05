/* Partial allows say “Probably”; this endpoint cannot prove every gate layer. */

import { type MetaFunction, useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { type ChangeEvent, type FormEvent, useMemo, useState } from "react";
import { TechnicalDetails } from "~/components/access/access-bits";
import { Code, PlainAnswer, ResultPanel } from "~/components/access/check-result";
import { TeamAccessEvidence } from "~/components/access/team-access-evidence";
import { AccessTabs } from "~/components/access-tabs";
import { FormStatus } from "~/components/form-status";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Panel } from "~/components/ui/panel";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { buildDirectory, lookupParty } from "~/lib/access-directory";
import { actionFor, CHECKABLE_THINGS, describeResourceType, verbsFor } from "~/lib/access-language";
import { ApiError, listResourceTypes, type ResourceTypeSummary } from "~/lib/api";
import {
  type EffectiveGrants,
  type ExplainQuery,
  type ExplainResult,
  explain,
  getEffectiveGrants,
} from "~/lib/authz";
import { explainTeamAccess, listTeams, type TeamDirectoryEntry } from "~/lib/teams";
import { listUsers, type UserSummary } from "~/lib/users";

export const meta: MetaFunction = () => [{ title: "Check access · Business · tulipfarm" }];

const INITIAL_FORM = {
  principalId: "",
  agentId: "",
  action: "",
  resourceType: "",
  domain: "",
  recordId: "",
  field: "",
  dataClass: "",
  destination: "",
  conditions: "",
  teamId: "",
};

type CheckForm = typeof INITIAL_FORM;
type OptionalTextKey = Exclude<
  keyof CheckForm,
  "principalId" | "action" | "resourceType" | "conditions" | "teamId"
>;

const OPTIONAL_TEXT_KEYS: OptionalTextKey[] = [
  "agentId",
  "domain",
  "recordId",
  "field",
  "dataClass",
  "destination",
];

/** Missing people/types data must not block exact-string checks in More precise. */
export async function clientLoader() {
  const [users, resourceTypes, teams] = await Promise.all([
    listUsers().catch((): UserSummary[] => []),
    listResourceTypes().catch((): ResourceTypeSummary[] => []),
    listTeams().catch((): { teams: TeamDirectoryEntry[] } => ({ teams: [] })),
  ]);
  return { users, recordTypes: resourceTypes.map((type) => type.name).sort(), teams: teams.teams };
}

export default function BusinessAccessCheck() {
  const { users, recordTypes, teams } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const [form, setForm] = useState<CheckForm>(INITIAL_FORM);
  const [verb, setVerb] = useState("read");
  const [thing, setThing] = useState("");
  const [result, setResult] = useState<ExplainResult | null>(null);
  const [teamExplanation, setTeamExplanation] = useState<Awaited<
    ReturnType<typeof explainTeamAccess>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [grants, setGrants] = useState<EffectiveGrants | null>(null);
  const [grantsBusy, setGrantsBusy] = useState(false);
  const [grantsError, setGrantsError] = useState<string | null>(null);

  const directory = useMemo(() => buildDirectory(users), [users]);
  const things = useMemo(
    () => [
      ...recordTypes.map((name) => ({
        value: `record.${name}`,
        label: describeResourceType(`record.${name}`),
      })),
      ...CHECKABLE_THINGS,
    ],
    [recordTypes]
  );

  // The sentence drives the query unless the operator overrode a string by hand below.
  const resolvedResourceType = form.resourceType.trim() || thing;
  /* Offer only verbs that compile to real actions for the chosen target. */
  const verbs = verbsFor(thing);
  const activeVerb = verbs.some((option) => option.value === verb) ? verb : (verbs[0]?.value ?? "");
  const resolvedAction = form.action.trim() || (thing ? (actionFor(thing, activeVerb) ?? "") : "");
  const ready =
    form.principalId.trim().length > 0 &&
    resolvedAction.length > 0 &&
    resolvedResourceType.length > 0;

  function updateField(key: keyof CheckForm) {
    return (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      setForm((current) => ({ ...current, [key]: event.target.value }));
    };
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setGrants(null);
    setGrantsError(null);
    setTeamExplanation(null);

    let query: ExplainQuery;
    try {
      query = buildExplainQuery({
        ...form,
        action: resolvedAction,
        resourceType: resolvedResourceType,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build this check.");
      return;
    }

    setBusy(true);
    try {
      const [decision, evidence] = await Promise.all([
        explain(query),
        form.teamId
          ? explainTeamAccess(form.teamId, {
              principalId: query.principalId,
              action: query.action,
              resourceType: query.resourceType,
              ...(query.agentId ? { agentId: query.agentId } : {}),
            })
          : Promise.resolve(null),
      ]);
      setResult(decision);
      setTeamExplanation(evidence);
      revalidator.revalidate();
    } catch (err) {
      setResult(null);
      setTeamExplanation(null);
      setError(explainErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadEffectiveGrants() {
    if (!result) return;
    setGrantsError(null);
    setGrantsBusy(true);
    try {
      setGrants(await getEffectiveGrants(result.principalId));
    } catch (err) {
      setGrants(null);
      setGrantsError(explainErrorMessage(err));
    } finally {
      setGrantsBusy(false);
    }
  }

  function reset() {
    setForm(INITIAL_FORM);
    setVerb("read");
    setThing("");
    setResult(null);
    setError(null);
    setGrants(null);
    setGrantsError(null);
  }

  return (
    <div className="space-y-6">
      <AccessTabs />

      <Panel
        title="Check what someone can do"
        description="Pick a person and what they were trying to do. If it does not work, we will say why."
      >
        <form onSubmit={onSubmit} className="space-y-5">
          <div className="grid items-end gap-3 lg:grid-cols-3">
            <Field label="Who" required>
              <Select value={form.principalId} onChange={updateField("principalId")}>
                <option value="">Choose a person…</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name?.trim() ? `${user.name}, ${user.email}` : user.email}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Trying to" required>
              <Select value={activeVerb} onChange={(event) => setVerb(event.target.value)}>
                {verbs.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="What" required>
              <Select value={thing} onChange={(event) => setThing(event.target.value)}>
                <option value="">Choose one…</option>
                {things.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {teams.length > 0 ? (
            <Field
              label="Team context (optional)"
              help="Choose a Team to include membership, ancestry, Role, grant, and deny evidence."
            >
              <Select value={form.teamId} onChange={updateField("teamId")}>
                <option value="">No Team evidence</option>
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.displayName}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          {ready ? (
            <p className="text-xs text-muted-foreground">
              Checking <Code>{resolvedAction}</Code> on <Code>{resolvedResourceType}</Code> for{" "}
              {lookupParty(directory, form.principalId.trim()).name}.
            </p>
          ) : null}

          <TechnicalDetails summary="More precise">
            <div className="space-y-4 pt-1">
              <p className="text-xs text-muted-foreground">
                For operators reproducing a real refusal. Anything set here overrides the sentence
                above; empty fields are not sent.
              </p>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                <Field label="Someone or something else" help="A principal id, when not a person.">
                  <Input
                    value={form.principalId}
                    onChange={updateField("principalId")}
                    placeholder="service:billing-api"
                  />
                </Field>
                <Field label="Action" help="Overrides the verb above.">
                  <Input
                    value={form.action}
                    onChange={updateField("action")}
                    placeholder={resolvedAction || "record.read"}
                  />
                </Field>
                <Field label="Resource type" help="Overrides the thing above.">
                  <Input
                    value={form.resourceType}
                    onChange={updateField("resourceType")}
                    placeholder={resolvedResourceType || "record.customer"}
                  />
                </Field>
                <Field
                  label="Agent ID"
                  help="Adds the Agent layer, so fewer layers are left unchecked."
                >
                  <Input
                    value={form.agentId}
                    onChange={updateField("agentId")}
                    placeholder="agent_sales"
                  />
                </Field>
                <Field label="Domain" help="Example: hr or engineering.">
                  <Input value={form.domain} onChange={updateField("domain")} placeholder="hr" />
                </Field>
                <Field label="Record ID">
                  <Input
                    value={form.recordId}
                    onChange={updateField("recordId")}
                    placeholder="rec_123"
                  />
                </Field>
                <Field label="Field">
                  <Input value={form.field} onChange={updateField("field")} placeholder="salary" />
                </Field>
                <Field label="Data class">
                  <Input
                    value={form.dataClass}
                    onChange={updateField("dataClass")}
                    placeholder="restricted"
                  />
                </Field>
                <Field label="Destination">
                  <Input
                    value={form.destination}
                    onChange={updateField("destination")}
                    placeholder="slack"
                  />
                </Field>
                <Field label="Conditions" help="One key=value pair per line.">
                  <Textarea
                    value={form.conditions}
                    onChange={updateField("conditions")}
                    placeholder={"region=us\npurpose=support"}
                    className="min-h-20"
                  />
                </Field>
              </div>
            </div>
          </TechnicalDetails>

          {error ? <FormStatus tone="error">{error}</FormStatus> : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={busy || !ready}>
              {busy ? "Checking…" : "Check"}
            </Button>
            <Button type="button" variant="ghost" onClick={reset}>
              Start over
            </Button>
          </div>
        </form>
      </Panel>

      {result ? (
        <>
          <PlainAnswer result={result} party={lookupParty(directory, result.principalId)} />
          <ResultPanel
            result={result}
            grants={grants}
            grantsBusy={grantsBusy}
            grantsError={grantsError}
            onLoadEffectiveGrants={loadEffectiveGrants}
          />
          {teamExplanation ? (
            <TeamAccessEvidence explanation={teamExplanation} teams={teams} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function buildExplainQuery(form: CheckForm): ExplainQuery {
  const query: ExplainQuery = {
    principalId: form.principalId.trim(),
    action: form.action.trim(),
    resourceType: form.resourceType.trim(),
  };

  for (const key of OPTIONAL_TEXT_KEYS) {
    const value = form[key].trim();
    if (value.length > 0) {
      query[key] = value;
    }
  }

  const conditions = parseConditions(form.conditions);
  if (conditions) {
    query.conditions = conditions;
  }

  return query;
}

function parseConditions(raw: string): Record<string, string> | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  const conditions: Record<string, string> = {};
  for (const line of trimmed.split(/\r?\n/)) {
    const compact = line.trim();
    if (compact.length === 0) continue;

    const separator = compact.indexOf("=");
    if (separator <= 0) {
      throw new Error("Conditions must use key=value, one pair per line.");
    }

    const key = compact.slice(0, separator).trim();
    const value = compact.slice(separator + 1).trim();
    if (key.length === 0 || value.length === 0) {
      throw new Error("Conditions must have a non-empty key and value.");
    }
    conditions[key] = value;
  }

  return Object.keys(conditions).length > 0 ? conditions : undefined;
}

function explainErrorMessage(err: unknown) {
  if (!(err instanceof ApiError)) return "Could not reach the API.";
  if (err.status === 403) {
    return "You are not a deployment admin. Ask a deployment admin to run this check.";
  }
  if (err.status === 404) {
    return "This principal is not known to the authorization system.";
  }
  return err.message;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = error instanceof ApiError ? explainErrorMessage(error) : "Could not load Check.";
  return <FormStatus tone="error">{message}</FormStatus>;
}
