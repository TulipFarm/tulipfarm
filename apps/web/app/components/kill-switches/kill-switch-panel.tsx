import { useId, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { Ban, ShieldAlert } from "~/components/icons";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Panel, PanelEmpty } from "~/components/ui/panel";
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
  const [scopeKind, setScopeKind] = useState(ALL_MUTATIONS);
  const [scopeValue, setScopeValue] = useState("");
  const [reasonCode, setReasonCode] = useState("");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const formId = useId();

  const live = model.killSwitches.filter((item) => item.enabled);
  const needsValue = scopeKind !== ALL_MUTATIONS;
  const canArm =
    reasonCode.trim().length > 0 && (!needsValue || scopeValue.trim().length > 0) && !busy;

  async function run(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the API.");
    } finally {
      setBusy(undefined);
    }
  }

  async function arm() {
    await run("arm", async () => {
      await armKillSwitch({
        scopeKind,
        ...(needsValue ? { scopeValue: scopeValue.trim() } : {}),
        reasonCode: reasonCode.trim(),
      });
      setScopeValue("");
      setReasonCode("");
    });
  }

  return (
    <Panel
      title="Kill switches"
      description="Stops matching mutating effects from the next dispatch onward. Reads and in-flight work are never affected, and standing a switch down keeps the record of when it was live."
      actions={
        live.length > 0 ? (
          <Badge variant="danger">
            <Ban aria-hidden="true" className="size-3" />
            {live.length} live
          </Badge>
        ) : (
          <Badge variant="success">All clear</Badge>
        )
      }
    >
      <div className="space-y-4">
        {error ? <FormStatus tone="error">{error}</FormStatus> : null}

        {live.length === 0 ? (
          <PanelEmpty>No kill switch is armed. Mutating effects run normally.</PanelEmpty>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {live.map((item: KillSwitch) => (
              <li key={item.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <ShieldAlert aria-hidden="true" className="size-4 shrink-0 text-status-danger" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {describeScope(item)}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {item.reasonCode} · armed by {item.enabledBy} at {formatWhen(item.enabledAt)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== undefined}
                  onClick={() => run(item.id, () => standDownKillSwitch(item.id))}
                >
                  {busy === item.id ? "Standing down…" : "Stand down"}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-3 border-t border-border pt-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Scope" htmlFor={`${formId}-scope`}>
              <Select
                id={`${formId}-scope`}
                value={scopeKind}
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
              placeholder="Why this stop is needed"
              onChange={(event) => setReasonCode(event.target.value)}
            />
          </Field>

          <Button variant="destructive" disabled={!canArm} onClick={arm}>
            {busy === "arm" ? "Arming…" : "Arm kill switch"}
          </Button>
        </div>
      </div>
    </Panel>
  );
}
