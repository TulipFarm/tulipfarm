/* Partial allows say “Probably”; this endpoint cannot prove every gate layer. */

import { type MetaFunction, useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { type ChangeEvent, type FormEvent, useMemo, useState } from "react";
import { TechnicalDetails } from "~/components/access/access-bits";
import { AccessTabs } from "~/components/access-tabs";
import { FormStatus } from "~/components/form-status";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Panel, PanelEmpty } from "~/components/ui/panel";
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
  isLayerFault,
  LAYER_EMPTY_REASON_LABEL,
} from "~/lib/authz";
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
};

type CheckForm = typeof INITIAL_FORM;
type OptionalTextKey = Exclude<
  keyof CheckForm,
  "principalId" | "action" | "resourceType" | "conditions"
>;

const OPTIONAL_TEXT_KEYS: OptionalTextKey[] = [
  "agentId",
  "domain",
  "recordId",
  "field",
  "dataClass",
  "destination",
];

const REASON_COPY: Record<
  ExplainResult["reason"],
  { label: string; meaning: string; remedy: string }
> = {
  allowed: {
    label: "No checked layer denied",
    meaning: "The live layers reached by this endpoint permitted the request.",
    remedy:
      "If this result is partial, add the Agent ID when known and inspect the Run, Guardrail, and Credential layers before promising it will work.",
  },
  no_layers: {
    label: "No authority layer resolved",
    meaning: "The principal did not resolve to any durable authority layer.",
    remedy: "Fix the principal first. Check that the ID exists in the authorization system.",
  },
  explicit_deny: {
    label: "Explicit deny matched",
    meaning: "A deliberate deny rule matched this request.",
    remedy: "Find the deny rule on the named layer and change or remove that rule.",
  },
  no_matching_allow: {
    label: "No matching allow",
    meaning:
      "Nothing prohibited this request, but nothing granted it either. Default deny applies.",
    remedy:
      "Grant an allow that matches this action, resource type, and every narrowing dimension.",
  },
};

/** One sentence an owner can act on, sitting above the layer-by-layer evidence. */
const PLAIN_REASON: Record<ExplainResult["reason"], string> = {
  allowed: "Nothing we can check here stands in the way.",
  no_layers: "We cannot find them in the access system at all, so they hold nothing.",
  explicit_deny: "Something deliberately blocks this, so giving them more access will not help.",
  no_matching_allow: "Nobody has given them this yet.",
};

/** Missing people/types data must not block exact-string checks in More precise. */
export async function clientLoader() {
  const [users, resourceTypes] = await Promise.all([
    listUsers().catch((): UserSummary[] => []),
    listResourceTypes().catch((): ResourceTypeSummary[] => []),
  ]);
  return { users, recordTypes: resourceTypes.map((type) => type.name).sort() };
}

export default function BusinessAccessCheck() {
  const { users, recordTypes } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const [form, setForm] = useState<CheckForm>(INITIAL_FORM);
  const [verb, setVerb] = useState("read");
  const [thing, setThing] = useState("");
  const [result, setResult] = useState<ExplainResult | null>(null);
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
      setResult(await explain(query));
      revalidator.revalidate();
    } catch (err) {
      setResult(null);
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
                    {user.name?.trim() ? `${user.name} — ${user.email}` : user.email}
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
        </>
      ) : null}
    </div>
  );
}

/** Partial allows say “Probably”, not “Yes”, because unreachable layers may still deny. */
function PlainAnswer({ result, party }: { result: ExplainResult; party: { name: string } }) {
  const tone = !result.allowed ? "danger" : result.partial ? "warning" : "success";
  const headline = !result.allowed ? "No." : result.partial ? "Probably." : "Yes.";
  const detail = !result.allowed
    ? PLAIN_REASON[result.reason]
    : result.partial
      ? "Nothing we can check here blocks it, but some checks only happen while the work is running."
      : "Everything we can check here allows it.";

  return (
    <section
      className={
        tone === "danger"
          ? "rounded-md border border-status-danger/30 bg-status-danger/5 p-4"
          : tone === "warning"
            ? "rounded-md border border-status-warning/30 bg-status-warning/5 p-4"
            : "rounded-md border border-status-success/30 bg-status-success/5 p-4"
      }
    >
      <p className="text-base font-semibold text-foreground">
        {headline} {party.name} {result.allowed ? "can do this" : "cannot do this"}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
      {!result.allowed && result.reason === "no_matching_allow" ? (
        <p className="mt-2 text-sm text-foreground">
          Give them the access on the People tab, or put them in a team that already has it.
        </p>
      ) : null}
    </section>
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

function ResultPanel({
  result,
  grants,
  grantsBusy,
  grantsError,
  onLoadEffectiveGrants,
}: {
  result: ExplainResult;
  grants: EffectiveGrants | null;
  grantsBusy: boolean;
  grantsError: string | null;
  onLoadEffectiveGrants: () => void;
}) {
  const reason = REASON_COPY[result.reason];

  return (
    <Panel
      title="Result"
      description={`Decision for ${result.principalId} (${result.kind}).`}
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={grantsBusy}
          onClick={onLoadEffectiveGrants}
        >
          {grantsBusy ? "Loading grants…" : "Load effective grants"}
        </Button>
      }
    >
      <div className="space-y-5">
        <Outcome result={result} />

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-foreground">Reason</span>
              <Badge variant={reasonBadgeVariant(result.reason)}>{reason.label}</Badge>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{reason.meaning}</p>
            <p className="mt-2 text-sm text-foreground">
              <span className="font-medium">What to do: </span>
              {reason.remedy}
            </p>
            {result.deniedLayer ? (
              <p className="mt-2 text-sm text-foreground">
                <span className="font-medium">Denied layer: </span>
                <Code>{result.deniedLayer}</Code>
              </p>
            ) : null}
            <LayerFaults result={result} />
          </div>

          <Layers result={result} />
        </div>

        {grantsError ? <FormStatus tone="error">{grantsError}</FormStatus> : null}
        {grants ? <EffectiveGrantsPanel grants={grants} /> : null}
      </div>
    </Panel>
  );
}

/** Dangling layer data denies differently from a considered no; remedies must not conflate them. */
function LayerFaults({ result }: { result: ExplainResult }) {
  const faults = Object.entries(result.layerEmptyReasons ?? {}).filter(([, reason]) =>
    isLayerFault(reason)
  );
  if (faults.length === 0) return null;
  return (
    <div className="mt-3 rounded-md border border-status-danger/30 bg-status-danger/5 p-3">
      <p className="text-sm font-medium text-foreground">
        This is a data fault, not a policy decision.
      </p>
      <ul className="mt-1 space-y-1">
        {faults.map(([layer, reason]) => (
          <li key={layer} className="text-sm text-muted-foreground">
            <Code>{layer}</Code> — {LAYER_EMPTY_REASON_LABEL[reason]}
          </li>
        ))}
      </ul>
      {result.unresolvedRoleIds && result.unresolvedRoleIds.length > 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">
          Unresolved Role{result.unresolvedRoleIds.length === 1 ? "" : "s"}:{" "}
          <Code>{result.unresolvedRoleIds.join(", ")}</Code>
        </p>
      ) : null}
      <p className="mt-1 text-sm text-foreground">
        Repair the assignment; granting more access will not change this answer.
      </p>
    </div>
  );
}

function Outcome({ result }: { result: ExplainResult }) {
  if (!result.allowed) {
    return (
      <div className="rounded-md border border-status-danger/30 bg-status-danger/5 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="danger">Denied</Badge>
          <p className="text-sm font-medium text-foreground">This denial is authoritative.</p>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          A checked layer denied this request. The real gate intersects every layer, so it will also
          deny.
        </p>
      </div>
    );
  }

  if (result.partial) {
    return (
      <div className="rounded-md border border-status-warning/30 bg-status-warning/5 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="warning">Partial allow only</Badge>
          <p className="text-sm font-medium text-foreground">This is not a guarantee.</p>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          No checked layer denied it, but the real gate also checks{" "}
          <LayerInline layers={result.unevaluatedLayers} />. Any one of those layers may still deny.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-status-success/30 bg-status-success/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="success">Clean allow</Badge>
        <p className="text-sm font-medium text-foreground">
          Every layer available to this check permitted it.
        </p>
      </div>
    </div>
  );
}

function Layers({ result }: { result: ExplainResult }) {
  return (
    <section aria-labelledby="scope-of-answer" className="rounded-md border border-border p-3">
      <h2 id="scope-of-answer" className="text-sm font-medium text-foreground">
        Scope of this answer
      </h2>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Evaluated layers</dt>
          <dd className="mt-1">
            <LayerList layers={result.evaluatedLayers} empty="None" />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Unevaluated layers</dt>
          <dd className="mt-1">
            <LayerList layers={result.unevaluatedLayers} empty="None" />
          </dd>
        </div>
      </dl>
    </section>
  );
}

function LayerInline({ layers }: { layers: string[] }) {
  if (layers.length === 0) return <span>no unevaluated layers</span>;
  return (
    <>
      {layers.map((layer, index) => (
        <span key={layer}>
          {index > 0 ? ", " : ""}
          <Code>{layer}</Code>
        </span>
      ))}
    </>
  );
}

function LayerList({ layers, empty }: { layers: string[]; empty: string }) {
  if (layers.length === 0) return <span className="text-sm text-muted-foreground">{empty}</span>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {layers.map((layer) => (
        <li key={layer}>
          <Code>{layer}</Code>
        </li>
      ))}
    </ul>
  );
}

function EffectiveGrantsPanel({ grants }: { grants: EffectiveGrants }) {
  return (
    <div className="rounded-md border border-border">
      <div className="border-b border-border px-3 py-2">
        <h2 className="text-sm font-medium text-foreground">Effective grants</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          What {grants.principalId} currently holds through direct and group assignments.
        </p>
      </div>
      {grants.grants.length === 0 ? (
        <PanelEmpty>No grants held.</PanelEmpty>
      ) : (
        <ul className="divide-y divide-border">
          {grants.grants.map((grant) => (
            <li key={grant.label} className="px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={grant.effect === "allow" ? "success" : "danger"}>
                  {grant.effect}
                </Badge>
                <Code>{grant.action}</Code>
                <Code>{grant.resourceType}</Code>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{grant.label}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Code({ children }: { children: string }) {
  return (
    <code className="rounded-sm border border-code-border bg-code-surface px-1.5 py-0.5 font-mono text-xs text-code-key">
      {children}
    </code>
  );
}

function reasonBadgeVariant(reason: ExplainResult["reason"]) {
  if (reason === "allowed") return "info";
  if (reason === "explicit_deny") return "danger";
  if (reason === "no_matching_allow") return "warning";
  return "neutral";
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = error instanceof ApiError ? explainErrorMessage(error) : "Could not load Check.";
  return <FormStatus tone="error">{message}</FormStatus>;
}
