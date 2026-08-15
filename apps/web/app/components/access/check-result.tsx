import { FormStatus } from "~/components/form-status";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import {
  type EffectiveGrants,
  type ExplainResult,
  isLayerFault,
  LAYER_EMPTY_REASON_LABEL,
} from "~/lib/authz";

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

/** Partial allows say “Probably”, not “Yes”, because unreachable layers may still deny. */
export function PlainAnswer({ result, party }: { result: ExplainResult; party: { name: string } }) {
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

export function ResultPanel({
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

export function Code({ children }: { children: string }) {
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
