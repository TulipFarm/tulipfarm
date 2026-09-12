import { useEffect, useId, useRef, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { Ban, ShieldAlert } from "~/components/icons";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Modal } from "~/components/ui/modal";
import { Select } from "~/components/ui/select";
import { ApiError } from "~/lib/api";
import {
  armKillSwitch,
  describeScope,
  type KillSwitch,
  type KillSwitchModel,
  scopeKindLabel,
  standDownKillSwitch,
} from "~/lib/kill-switches";

const ALL_MUTATIONS = "all_mutations";

function formatWhen(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

/**
 * The operator surface for the mutation kill switch — the emergency stop over mutating Tool
 * effects. It is deliberately on the incident console rather than behind a settings tree: the
 * moment it is needed is the moment nobody should be hunting for it.
 */
export function KillSwitchPanel({
  model,
  onChanged,
}: {
  model: KillSwitchModel;
  onChanged: () => void;
}) {
  const [scopeKind, setScopeKind] = useState(
    model.enforceableScopeKinds.includes(ALL_MUTATIONS)
      ? ALL_MUTATIONS
      : (model.enforceableScopeKinds[0] ?? "")
  );
  const [scopeValue, setScopeValue] = useState("");
  const [reasonCode, setReasonCode] = useState("");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [pendingArm, setPendingArm] = useState<Parameters<typeof armKillSwitch>[0] | null>(null);
  const armButton = useRef<HTMLButtonElement>(null);
  const configureSummary = useRef<HTMLElement>(null);
  const returnFocus = useRef(false);
  const formId = useId();

  useEffect(() => {
    if (!pendingArm && returnFocus.current) {
      if (armButton.current?.disabled) configureSummary.current?.focus();
      else armButton.current?.focus();
      returnFocus.current = false;
    }
  }, [pendingArm]);

  const live = model.killSwitches.filter((item) => item.enabled);
  const needsValue = scopeKind !== ALL_MUTATIONS;
  const canArm =
    model.enforceableScopeKinds.includes(scopeKind) &&
    reasonCode.trim().length > 0 &&
    (!needsValue || scopeValue.trim().length > 0) &&
    !busy;

  async function run(key: string, action: () => Promise<unknown>) {
    if (busy) return false;
    setBusy(key);
    setError(null);
    try {
      await action();
      onChanged();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the API.");
      return false;
    } finally {
      setBusy(undefined);
    }
  }

  async function arm() {
    if (!pendingArm) return;
    const succeeded = await run("arm", () => armKillSwitch(pendingArm));
    if (succeeded) {
      setScopeValue("");
      setReasonCode("");
      setPendingArm(null);
    }
  }

  return (
    <section
      id="operations-emergency-stop"
      aria-labelledby={`${formId}-title`}
      className="min-w-0 scroll-mt-4 rounded-md border border-border bg-card"
    >
      <header className="flex flex-wrap items-center gap-2 px-4 pt-4">
        <Ban aria-hidden="true" className="size-4 text-muted-foreground" />
        <h2 id={`${formId}-title`} className="text-sm font-medium">
          Emergency stop
        </h2>
        {live.length > 0 ? (
          <Badge variant="danger" className="ml-auto">
            {live.length} active {live.length === 1 ? "stop" : "stops"}
          </Badge>
        ) : null}
      </header>
      <div className="space-y-3 p-4">
        <p className="max-w-prose text-sm text-muted-foreground">
          Stops matching mutating Tool effects from the next dispatch. Reads and in-flight work are
          not affected. Stand down a stop to allow future effects; its audit record remains.
        </p>
        {error && !pendingArm ? <FormStatus tone="error">{error}</FormStatus> : null}

        {live.length === 0 ? (
          <p className="text-sm text-muted-foreground">No kill switch is armed.</p>
        ) : (
          <ul className="divide-y divide-border">
            {live.map((item: KillSwitch) => (
              <li key={item.id} className="flex flex-wrap items-start gap-3 py-3">
                <ShieldAlert aria-hidden="true" className="size-4 shrink-0 text-status-danger" />
                <div className="min-w-0 flex-1 basis-40 break-words">
                  <p className="text-sm font-medium text-foreground">{describeScope(item)}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.reasonCode} · armed by {item.enabledBy} at {formatWhen(item.enabledAt)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Stand down ${describeScope(item)}`}
                  disabled={busy !== undefined}
                  onClick={() => run(item.id, () => standDownKillSwitch(item.id))}
                >
                  {busy === item.id ? "Standing down…" : "Stand down"}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <details className="border-t border-border">
          <summary
            ref={configureSummary}
            className="min-h-11 cursor-pointer py-3 text-sm font-medium hover:text-muted-foreground"
          >
            Configure emergency stop
          </summary>
          <div className="max-w-2xl space-y-3 pb-1 pt-1">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Scope" htmlFor={`${formId}-scope`}>
                <Select
                  id={`${formId}-scope`}
                  value={scopeKind}
                  disabled={busy !== undefined}
                  className="h-11 text-base sm:h-9 sm:text-sm pointer-coarse:h-11"
                  onChange={(event) => setScopeKind(event.target.value)}
                >
                  {model.enforceableScopeKinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {scopeKindLabel(kind)}
                    </option>
                  ))}
                </Select>
              </Field>

              {needsValue ? (
                <Field label="Which one" htmlFor={`${formId}-value`}>
                  <Input
                    id={`${formId}-value`}
                    value={scopeValue}
                    disabled={busy !== undefined}
                    placeholder="Exact identifier"
                    onChange={(event) => setScopeValue(event.target.value)}
                  />
                </Field>
              ) : null}
            </div>

            <Field
              label="Reason"
              htmlFor={`${formId}-reason`}
              help="Recorded on the audit ledger and shown to whoever stands this down."
            >
              <Input
                id={`${formId}-reason`}
                value={reasonCode}
                disabled={busy !== undefined}
                placeholder="Why this stop is needed"
                onChange={(event) => setReasonCode(event.target.value)}
              />
            </Field>

            <Button
              ref={armButton}
              variant="outline"
              disabled={!canArm}
              onClick={() => {
                setError(null);
                returnFocus.current = true;
                setPendingArm({
                  scopeKind,
                  ...(needsValue ? { scopeValue: scopeValue.trim() } : {}),
                  reasonCode: reasonCode.trim(),
                });
              }}
            >
              Arm kill switch
            </Button>
          </div>
        </details>
      </div>
      <Modal
        open={pendingArm !== null}
        title="Arm kill switch?"
        className="w-[calc(100%_-_2rem)] [&>div>button]:min-h-11 [&>div>button]:min-w-11"
        onClose={() => {
          if (!busy) {
            setError(null);
            setPendingArm(null);
          }
        }}
      >
        {pendingArm ? (
          <>
            <dl className="space-y-3 break-words">
              <div>
                <dt className="text-muted-foreground">Scope</dt>
                <dd className="mt-1 font-medium">{describeScope(pendingArm)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Reason recorded on the audit ledger</dt>
                <dd className="mt-1">{pendingArm.reasonCode}</dd>
              </div>
            </dl>
            <p className="mt-4 text-sm text-muted-foreground">
              Matching mutating effects will be refused from the next dispatch. Reads and in-flight
              work continue. Stand this stop down to allow future matching effects.
            </p>
            {error ? (
              <div className="mt-3">
                <FormStatus tone="error">{error}</FormStatus>
              </div>
            ) : null}
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                disabled={busy !== undefined}
                onClick={() => {
                  setError(null);
                  setPendingArm(null);
                }}
              >
                Cancel
              </Button>
              <Button variant="destructive" disabled={busy !== undefined} onClick={arm}>
                {busy === "arm" ? "Arming…" : "Confirm arm kill switch"}
              </Button>
            </div>
          </>
        ) : null}
      </Modal>
    </section>
  );
}
