import { Pencil } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  capabilityLabels,
  type EmbeddingRow,
  isEntryReady,
  type Row,
  specFacts,
} from "~/components/model-chains/chain-data";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Combobox } from "~/components/ui/combobox";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Sheet } from "~/components/ui/sheet";
import {
  type ConnectionTest,
  getModelOptions,
  isProviderConfigured,
  type LlmProviderInfo,
  type ModelOptions,
  type ModelSpec,
  resolveModelSpec,
  testLlmConnection,
} from "~/lib/settings";

/** Show a stored per-token cost as the per-million figure the operator typed. */
function perMtokValue(cost: number | undefined): string {
  if (cost == null) return "";
  return String(Number((cost * 1_000_000).toFixed(6)));
}

export type SheetKind = "chat" | "embedding";

const TEST_TONE = {
  pass: "bg-status-success-surface text-status-success",
  warn: "bg-status-warning-surface text-status-warning",
  fail: "bg-status-danger-surface text-status-danger",
};

/**
 * A model that answered, but not with the word it was asked for, is amber here and green on the
 * status page. Both are right: the deployment is healthy, and the operator standing on this screen
 * still wants to know the model ignored the simplest instruction it will ever get.
 */
function testTone(test: ConnectionTest): string {
  if (test.verdict === "unreachable") return TEST_TONE.fail;
  if (test.verdict === "degraded") return TEST_TONE.warn;
  return test.answeredAsAsked === false ? TEST_TONE.warn : TEST_TONE.pass;
}

/**
 * The probe's detail is written for the status page, so it names the screen that fixes the
 * problem. Here the operator is already on that screen, and being sent to where they are standing
 * reads as the message not knowing what it is attached to.
 */
function localDetail(detail: string | undefined): string | undefined {
  const local = detail?.replace(/\s*—\s*[^—]*under Business . Models\s*$/u, "");
  return local === "" ? undefined : local;
}

function testSummary(test: ConnectionTest, kind: SheetKind): string {
  const took = test.latencyMs === undefined ? "" : ` in ${test.latencyMs} ms`;
  if (test.verdict === "unreachable") return "No answer from this provider.";
  if (test.verdict === "degraded") return "The provider answered, but refused this call.";
  if (kind === "embedding") {
    return `Embedded a ${test.dimension}-wide vector${took}.`;
  }
  if (!test.reply) return `Answered${took}, but wrote nothing.`;
  // Quoting what it said is the point of the probe: it separates a model that read the prompt from
  // a route that accepts anything and echoes a canned body.
  return test.answeredAsAsked === false
    ? `Answered “${test.reply}”${took}, not the word it was asked for.`
    : `Replied “${test.reply}”${took}.`;
}

type SheetRow = Row | EmbeddingRow;

export function ModelSheet({
  open,
  kind,
  title,
  row,
  providers,
  secretKeys,
  focusPricing = false,
  onCancel,
  onDone,
  onChange,
}: {
  open: boolean;
  kind: SheetKind;
  title: string;
  row: SheetRow | undefined;
  providers: LlmProviderInfo[];
  secretKeys: string[];
  /** Opened from a missing-cost cell, so the price fields must already be showing on arrival. */
  focusPricing?: boolean;
  onCancel: () => void;
  onDone: () => void;
  onChange: (patch: Partial<EmbeddingRow>) => void;
}) {
  const [options, setOptions] = useState<ModelOptions | null>(null);
  const [resolving, setResolving] = useState(false);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [unmatched, setUnmatched] = useState(false);
  // Opened by the operator, or forced open by a catalogue miss. A private Azure deployment or a
  // self-hosted endpoint is never in the catalogue, so without a way to type the numbers in, that
  // model's spend can never be priced at all.
  const [manual, setManual] = useState(false);
  // Cleared when the sheet closes, so re-opening a row never shows the refusal from a previous
  // visit to a value that has since been discarded.
  const [errors, setErrors] = useState<{ provider?: string; model?: string } | null>(null);
  const [tested, setTested] = useState<{ key: string; result: ConnectionTest } | null>(null);
  const [testing, setTesting] = useState(false);
  const provider = row?.provider;
  const model = row?.model;

  useEffect(() => {
    if (!open) {
      setErrors(null);
      setManual(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !provider) {
      setOptions(null);
      return;
    }
    let live = true;
    setOptions(null);
    getModelOptions(provider, kind)
      .then((next) => {
        if (live) setOptions(next);
      })
      .catch(() => {
        if (live)
          setOptions({ models: [], source: "unavailable", reason: "Could not reach the API." });
      });
    return () => {
      live = false;
    };
  }, [open, provider, kind]);

  /** Catalogue misses still need a context window so runtime budgeting can work. */
  async function pinSpec(candidate?: string, modelOverride?: string) {
    const targetModel = modelOverride ?? model;
    if (!provider || !targetModel) return;
    setResolving(true);
    try {
      const result = await resolveModelSpec(provider, targetModel, false, candidate);
      if (result.spec) {
        onChange({ spec: result.spec });
        setCandidates([]);
        setUnmatched(false);
      } else if (result.candidates.length > 0) {
        setCandidates(result.candidates);
        setUnmatched(false);
      } else {
        setCandidates([]);
        setUnmatched(true);
      }
    } catch {
      setCandidates([]);
      setUnmatched(true);
    } finally {
      setResolving(false);
    }
  }

  const ready = isEntryReady(providers, secretKeys, provider);
  const facts = specFacts(row?.spec);
  const capabilities = capabilityLabels(row?.spec);
  // `Field` wires its label by cloning a single child, which the Combobox's wrapper div is not.
  // The id and describedby are therefore placed on the inner input by hand.
  const modelFieldId = useId();
  const modelHelpId = `${modelFieldId}-help`;
  const dimension = kind === "embedding" ? (row as EmbeddingRow | undefined)?.dimension : undefined;
  // A verdict is only ever about the entry that produced it, so it is tagged with that entry and
  // read back by match. Clearing it from an effect instead would leave a green tick standing for
  // one render beside a model that was never tested.
  const entryKey = `${kind}\u0000${provider ?? ""}\u0000${model ?? ""}`;
  const test = tested?.key === entryKey ? tested.result : null;
  const showManual = manual || unmatched || focusPricing;

  /** Write one spec number, dropping the key when the field is cleared so it never saves as 0. */
  function patchSpec(key: keyof ModelSpec, raw: string, min: number, divisor = 1) {
    const spec: ModelSpec = { ...row?.spec };
    const parsed = Number.parseFloat(raw);
    if (raw.trim() === "" || !Number.isFinite(parsed) || parsed < min) delete spec[key];
    else Object.assign(spec, { [key]: parsed / divisor });
    onChange({ spec: Object.keys(spec).length > 0 ? spec : undefined });
  }

  async function runTest() {
    if (!row?.model.trim()) return;
    const key = entryKey;
    setTesting(true);
    setTested(null);
    try {
      setTested({ key, result: await testLlmConnection(row, kind) });
    } catch (err) {
      // The probe route answers with a verdict for every provider outcome, so reaching here means
      // the request itself failed — a different problem, and it must not read as a model verdict.
      setTested({
        key,
        result: {
          verdict: "unreachable",
          detail: err instanceof Error ? err.message : "The test request did not complete.",
        },
      });
    } finally {
      setTesting(false);
    }
  }

  function finish() {
    if (!row) return;
    if (!row.provider.trim()) {
      setErrors({ provider: "Select a provider." });
      return;
    }
    if (!row.model.trim()) {
      setErrors({ model: "Enter a model." });
      return;
    }
    setErrors(null);
    onDone();
  }

  return (
    <Sheet open={open} onClose={onCancel} title={title}>
      {row ? (
        <div className="space-y-5 p-4">
          <Field
            label="Provider"
            error={errors?.provider}
            help={ready ? undefined : "This provider has no credential yet."}
          >
            <Select
              value={row.provider}
              onChange={(e) => {
                setErrors(null);
                setCandidates([]);
                setUnmatched(false);
                onChange({ provider: e.target.value, model: "", spec: undefined });
              }}
            >
              <option value="">Select a provider…</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {isProviderConfigured(p, secretKeys) ? "" : " (no credential)"}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Model"
            htmlFor={modelFieldId}
            error={errors?.model}
            help={
              options?.source === "live"
                ? "Listed from your configured endpoint."
                : options?.source === "catalog"
                  ? "Suggested from the model catalog. Anything your provider accepts will work."
                  : (options?.reason ?? "Enter it exactly as your provider spells it.")
            }
          >
            <Combobox
              id={modelFieldId}
              aria-describedby={modelHelpId}
              value={row.model}
              options={options?.models ?? []}
              onValueChange={(next) => {
                onChange({ model: next, spec: undefined });
                setErrors(null);
                setCandidates([]);
                setUnmatched(false);
              }}
              onCommit={(next) => {
                if (next.trim()) void pinSpec(undefined, next);
              }}
              placeholder="e.g. gpt-4o-mini"
              emptyLabel="Not in the catalogue. It is still saved as typed."
              inputClassName="font-mono"
            />
          </Field>

          {kind === "embedding" ? (
            <Field
              label="Vector width"
              help="The dimension this model returns. A standby may only take over from a model of the same width — a different one writes vectors no later query can match."
            >
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                value={dimension ?? ""}
                onChange={(e) => {
                  const parsed = Number.parseInt(e.target.value, 10);
                  onChange({ dimension: Number.isFinite(parsed) ? parsed : undefined });
                }}
                placeholder="1536"
                className="tabular-nums"
              />
            </Field>
          ) : null}

          <section className="rounded-md border border-border">
            <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-foreground">Connection</h3>
                <p className="text-xs text-muted-foreground">
                  {kind === "embedding"
                    ? "Embeds one word and reports the vector width it got back."
                    : "Asks the model for one word back."}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={runTest}
                disabled={testing || !row.model.trim()}
              >
                {testing ? "Testing…" : "Test connection"}
              </Button>
            </div>
            {test ? (
              <div className={`px-3 py-2 text-sm ${testTone(test)}`}>
                <p className="font-medium">{testSummary(test, kind)}</p>
                {localDetail(test.detail) ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">{localDetail(test.detail)}</p>
                ) : null}
                {kind === "embedding" && test.dimension && test.dimension !== dimension ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-1 -ml-2 h-7 px-2"
                    onClick={() => onChange({ dimension: test.dimension })}
                  >
                    Use {test.dimension} as the vector width
                  </Button>
                ) : null}
              </div>
            ) : (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                Not tested. Nothing else here proves the credential works until a real turn needs
                it.
              </p>
            )}
          </section>

          <section className="rounded-md border border-border">
            <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
              <h3 className="text-sm font-medium text-foreground">Pricing and limits</h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void pinSpec()}
                disabled={resolving || !row.model.trim()}
              >
                {resolving ? "Looking up…" : "Refresh"}
              </Button>
            </div>
            <div className="p-3">
              {facts.length > 0 ? (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                  {facts.map((fact) => (
                    <div key={fact.term}>
                      <dt className="text-xs text-muted-foreground">{fact.term}</dt>
                      <dd className="mt-0.5 text-sm tabular-nums text-foreground">{fact.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {resolving
                    ? "Looking this model up in the catalog…"
                    : "Looked up automatically once a model is chosen. Until then, spend on this model is unknown in Observability."}
                </p>
              )}

              {capabilities.length > 0 ? (
                <ul className="mt-3 flex flex-wrap gap-1">
                  {capabilities.map((capability) => (
                    <li key={capability}>
                      <Badge>{capability}</Badge>
                    </li>
                  ))}
                </ul>
              ) : null}

              {candidates.length > 0 ? (
                <div className="mt-3 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Several catalogue entries match “{row.model}”. Pick the one you are actually
                    calling.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {candidates.map((candidate) => (
                      <Button
                        key={candidate}
                        variant="outline"
                        size="sm"
                        className="font-mono text-xs"
                        onClick={() => void pinSpec(candidate)}
                      >
                        {candidate}
                      </Button>
                    ))}
                  </div>
                </div>
              ) : null}

              {showManual ? (
                <div className="mt-3 space-y-3 border-t border-border pt-3">
                  <p className="text-xs text-muted-foreground">
                    {unmatched
                      ? "Not in the catalogue — a private deployment or a self-hosted endpoint. Enter what your provider charges so this model's spend is not invisible."
                      : "Override what the catalogue reported."}
                  </p>
                  {kind === "chat" ? (
                    <Field
                      label="Context window"
                      help="Max input tokens, so the runtime can budget a turn against it."
                    >
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        value={row.spec?.max_input_tokens ?? ""}
                        onChange={(e) => patchSpec("max_input_tokens", e.target.value, 1)}
                        placeholder="131072"
                        className="tabular-nums"
                      />
                    </Field>
                  ) : null}
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Input $ / 1M tokens">
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="0.01"
                        value={perMtokValue(row.spec?.input_cost_per_token)}
                        onChange={(e) =>
                          patchSpec("input_cost_per_token", e.target.value, 0, 1_000_000)
                        }
                        placeholder="0.25"
                        className="tabular-nums"
                      />
                    </Field>
                    <Field label="Output $ / 1M tokens">
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="0.01"
                        value={perMtokValue(row.spec?.output_cost_per_token)}
                        onChange={(e) =>
                          patchSpec("output_cost_per_token", e.target.value, 0, 1_000_000)
                        }
                        placeholder="2.00"
                        className="tabular-nums"
                      />
                    </Field>
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => setManual(true)}
                >
                  <Pencil aria-hidden />
                  Enter these by hand
                </Button>
              )}
            </div>
          </section>

          <details className="rounded-md border border-border">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-foreground">
              Connection overrides
            </summary>
            <div className="space-y-3 border-t border-border p-3">
              <Field label="API key reference" help="Leave empty to use the provider default.">
                <Input
                  value={row.api_key_ref ?? ""}
                  onChange={(e) => onChange({ api_key_ref: e.target.value })}
                  className="font-mono"
                />
              </Field>
              <Field label="Base URL" help="Only for self-hosted or proxied endpoints.">
                <Input
                  value={row.base_url ?? ""}
                  onChange={(e) => onChange({ base_url: e.target.value })}
                  className="font-mono"
                />
              </Field>
              <Field label="Resource name" help="Azure deployments only.">
                <Input
                  value={row.resource_name ?? ""}
                  onChange={(e) => onChange({ resource_name: e.target.value })}
                  className="font-mono"
                />
              </Field>
            </div>
          </details>

          <div className="flex justify-end">
            <Button size="sm" onClick={finish}>
              Done
            </Button>
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}
