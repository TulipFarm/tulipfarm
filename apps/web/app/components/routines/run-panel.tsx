import { useId, useState } from "react";
import { Play, ShieldCheck } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Panel } from "~/components/ui/panel";
import { Select } from "~/components/ui/select";
import type { RoutineInputsSchema } from "~/lib/routines";

export type Inputs = Record<string, unknown>;

/**
 * The inputs a Routine declares, rendered from its `spec.input` JSON Schema.
 *
 * Validation stays server-authoritative — the API's 400 is the answer, and re-deriving the rule
 * here would give a reader two verdicts that can disagree. `required` is marked so the form does
 * not look optional, but nothing is blocked on it locally.
 */
function InputFields({
  schema,
  values,
  onChange,
  idPrefix,
  disabled,
}: {
  schema: RoutineInputsSchema;
  values: Inputs;
  onChange: (key: string, value: unknown) => void;
  idPrefix: string;
  disabled: boolean;
}) {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  return (
    <>
      {Object.entries(properties).map(([key, prop]) => {
        const id = `${idPrefix}-${key}`;
        if (prop.enum) {
          return (
            <Field key={key} label={key} help={prop.description} required={required.has(key)}>
              <Select
                disabled={disabled}
                value={String(values[key] ?? "")}
                onChange={(event) => onChange(key, event.target.value)}
              >
                <option value="">Not set</option>
                {prop.enum.map((option) => (
                  <option key={String(option)} value={String(option)}>
                    {String(option)}
                  </option>
                ))}
              </Select>
            </Field>
          );
        }
        if (prop.type === "boolean") {
          return (
            <div key={key} className="flex items-center gap-2 pt-1">
              <Checkbox
                id={id}
                disabled={disabled}
                checked={Boolean(values[key])}
                onChange={(event) => onChange(key, event.target.checked)}
              />
              <label htmlFor={id} className="text-sm text-foreground">
                {key}
                {required.has(key) ? <span className="ml-1 text-muted-foreground">*</span> : null}
              </label>
            </div>
          );
        }
        const isNumber = prop.type === "number" || prop.type === "integer";
        return (
          <Field key={key} label={key} help={prop.description} required={required.has(key)}>
            <Input
              disabled={disabled}
              type={isNumber ? "number" : "text"}
              value={String(values[key] ?? "")}
              onChange={(event) =>
                onChange(key, isNumber ? Number(event.target.value) : event.target.value)
              }
            />
          </Field>
        );
      })}
    </>
  );
}

export interface RunPanelProps {
  slug: string;
  inputs: RoutineInputsSchema | null;
  onRun: (inputs: Inputs) => Promise<void>;
  onDryRun: (inputs: Inputs) => Promise<void>;
  /** Whether the Routine reaches anything outside the instance, which is what makes Run costly. */
  hasEffects: boolean;
  busy?: "run" | "dry-run" | null;
  error?: string | null;
  /** Announced politely when an action resolves somewhere other than beside the button. */
  status?: string | null;
}

/**
 * Starting the Routine, for real or as a rehearsal.
 *
 * Both buttons take the same inputs and sit in the same panel on purpose. Offering a dry run in a
 * different place from the real one is what makes people skip it: the moment a person is willing
 * to rehearse is the moment they are already looking at the Run button and hesitating.
 *
 * "Run now" is the primary and is not gated behind a confirmation, because a Routine is a thing
 * whose entire purpose is to be run and it is already governed — its authority is bounded by its
 * `permissionCeiling`, its Tool calls pass the approval broker, and its `approval` States stop for
 * a person. A modal on top of that is friction that teaches people to click through modals. What
 * it gets instead is an honest label of what it will touch.
 */
export function RunPanel({
  slug,
  inputs,
  onRun,
  onDryRun,
  hasEffects,
  busy = null,
  error = null,
  status = null,
}: RunPanelProps) {
  const idPrefix = useId();
  const [values, setValues] = useState<Inputs>({});
  const schema = inputs ?? {};
  const hasInputs = Object.keys(schema.properties ?? {}).length > 0;
  const setValue = (key: string, value: unknown) =>
    setValues((previous) => ({ ...previous, [key]: value }));

  return (
    <Panel
      title="Run this routine"
      description={
        hasEffects
          ? "A real run reaches outside this instance. A dry run walks the same steps and shows every call it would have made, without making any of them."
          : "This routine only computes. A dry run walks the same steps and shows what each one would produce."
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void onRun(values);
        }}
      >
        {hasInputs ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <InputFields
              schema={schema}
              values={values}
              onChange={setValue}
              idPrefix={idPrefix}
              disabled={busy !== null}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">This routine takes no inputs.</p>
        )}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={busy !== null}>
            <Play aria-hidden="true" className="size-3.5" />
            {busy === "run" ? "Starting…" : "Run now"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void onDryRun(values)}
          >
            <ShieldCheck aria-hidden="true" className="size-3.5" />
            {busy === "dry-run" ? "Simulating…" : "Dry run"}
          </Button>
        </div>
        {/*
         * Both buttons resolve somewhere else on the page — a Run into the history table, a dry
         * run into a panel below. Rendered empty and kept mounted so a repeated announcement
         * still fires; inserting the region with its text does not reliably announce.
         */}
        <p role="status" className="sr-only">
          {status ?? ""}
        </p>
        <p className="text-xs text-muted-foreground">
          A run acts with your authority, not the routine&rsquo;s. Started from{" "}
          <span className="font-mono">{slug}</span>.
        </p>
      </form>
    </Panel>
  );
}
