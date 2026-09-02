/** Interactive blocks: every one collects operator input and posts it back through `onInteraction`. */

import type { SurfaceAction, SurfaceArtifact } from "@tulipfarm/surface";
import type { ChangeEvent, FormEvent, ReactElement } from "react";
import { useId, useState } from "react";
import { ActionButton, inlineMarkup, type SurfaceWebProps } from "../primitives";

type Choice = {
  label: string;
  value: string;
  detail?: string;
  confidence?: "high" | "medium" | "low";
};

const CONFIDENCE_LABEL: Record<NonNullable<Choice["confidence"]>, string> = {
  high: "High confidence",
  medium: "Needs review",
  low: "Low confidence",
};

/**
 * An unstated confidence is not a low one. Without these words an empty meter reads as a score of
 * zero, which is a claim the agent never made.
 */
const NO_CONFIDENCE_LABEL = "No signal";

function confidenceLabel(confidence: Choice["confidence"]): string {
  return confidence === undefined ? NO_CONFIDENCE_LABEL : CONFIDENCE_LABEL[confidence];
}

const CONFIDENCE_BARS: Record<NonNullable<Choice["confidence"]>, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * How sure the agent is, as three bars. Always draws all three so the reader sees the
 * denominator — two filled bars only means something next to the one that is not.
 */
function SignalMeter({ confidence }: { readonly confidence?: Choice["confidence"] }) {
  const filled = confidence === undefined ? 0 : CONFIDENCE_BARS[confidence];
  return (
    <span data-surface-signal data-confidence={confidence ?? "none"} aria-hidden="true">
      {[0, 1, 2].map((bar) => (
        <span key={bar} data-surface-signal-bar data-filled={bar < filled ? "true" : "false"} />
      ))}
    </span>
  );
}

/**
 * A mutually exclusive decision.
 *
 * Two shapes, chosen by the data rather than by taste. When the agent names a `recommend` value
 * the card leads with that option in prose, states its confidence, and files the rest behind an
 * Alternatives drawer — the reader can accept the recommendation without reading past the first
 * line. When no `recommend` is given the card lists every option at equal weight, because a
 * surface that leads with one option is making a recommendation, and it must never make one the
 * agent did not.
 */
export function SurfaceChoices({
  artifact,
  props,
  onInteraction,
  actionHandleFor,
}: {
  readonly artifact: SurfaceArtifact;
  readonly props: Record<string, unknown>;
  readonly onInteraction?: SurfaceWebProps["onInteraction"];
  readonly actionHandleFor?: SurfaceWebProps["actionHandleFor"];
}) {
  const choices = props.choices as Choice[];
  const action = props.action as SurfaceAction;
  const recommend = typeof props.recommend === "string" ? props.recommend : undefined;
  const recommendedIndex = choices.findIndex((choice) => choice.value === recommend);

  const [leadIndex, setLeadIndex] = useState(recommendedIndex);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string>();
  const questionId = `surface-${artifact.id}-question`;

  const choose = (choice: Choice) => ({
    ...action,
    payload: { ...action.payload, value: choice.value },
  });

  const question = (
    <header data-surface-choices-header>
      <h3 id={questionId}>{inlineMarkup(String(props.question))}</h3>
    </header>
  );

  const lead = choices[leadIndex];
  if (lead === undefined) {
    return (
      <section data-surface-choices aria-labelledby={questionId}>
        {question}
        <div data-surface-choice-list>
          {choices.map((choice) => (
            <ActionButton
              key={choice.value}
              label={choice.label}
              action={choose(choice)}
              disabled={selected !== undefined}
              selected={selected === choice.value}
              onInteraction={async (handle, input) => {
                setSelected(choice.value);
                try {
                  await onInteraction?.(handle, input);
                } catch {
                  setSelected(undefined);
                }
              }}
              actionHandleFor={actionHandleFor}
            />
          ))}
        </div>
      </section>
    );
  }

  const alternatives = choices.filter((_, index) => index !== leadIndex);
  const decided = selected !== undefined;

  return (
    <section data-surface-choices data-surface-recommend aria-labelledby={questionId}>
      {question}
      <div data-surface-choices-body>
        {/* Keyed on the value so promoting an alternative replays the entry, not a silent swap. */}
        <p key={lead.value} data-surface-choices-detail>
          {inlineMarkup(lead.detail ?? lead.label)}
        </p>
      </div>

      {alternatives.length === 0 ? null : (
        <div
          data-surface-choices-drawer
          data-open={open ? "true" : "false"}
          // `inert` rather than `hidden`: the drawer animates its height, so it stays in the box
          // tree while closed, and without this its buttons stay in the tab order the whole time.
          inert={open ? undefined : true}
        >
          <div data-surface-choices-drawer-clip>
            <div data-surface-choices-drawer-body>
              <p data-surface-choices-drawer-title>Other options</p>
              {alternatives.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  disabled={decided}
                  data-surface-choices-alternative
                  onClick={() => {
                    setLeadIndex(choices.indexOf(choice));
                    setOpen(false);
                  }}
                >
                  <SignalMeter confidence={choice.confidence} />
                  <span data-surface-choices-alternative-label>{inlineMarkup(choice.label)}</span>
                  <span data-surface-choices-alternative-meta>
                    {confidenceLabel(choice.confidence)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <footer data-surface-choices-footer>
        <span data-surface-choices-confidence>
          <SignalMeter confidence={lead.confidence} />
          <span>{confidenceLabel(lead.confidence)}</span>
        </span>
        <span data-surface-choices-controls>
          {alternatives.length === 0 ? null : (
            <button
              type="button"
              data-surface-button
              data-variant="secondary"
              aria-expanded={open}
              disabled={decided}
              onClick={() => setOpen((current) => !current)}
            >
              <span>Alternatives</span>
            </button>
          )}
          <ActionButton
            label={decided ? "Accepted" : lead.label}
            action={choose(lead)}
            disabled={decided}
            state={decided ? "accepted" : undefined}
            primary
            onInteraction={async (handle, input) => {
              setSelected(lead.value);
              try {
                await onInteraction?.(handle, input);
              } catch {
                setSelected(undefined);
              }
            }}
            actionHandleFor={actionHandleFor}
          />
        </span>
      </footer>
    </section>
  );
}

export function SurfaceMultiChoice({
  artifact,
  props,
  onInteraction,
  actionHandleFor,
}: {
  readonly artifact: SurfaceArtifact;
  readonly props: Record<string, unknown>;
  readonly onInteraction?: SurfaceWebProps["onInteraction"];
  readonly actionHandleFor?: SurfaceWebProps["actionHandleFor"];
}) {
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const choices = props.choices as Array<{ label: string; value: string }>;
  const action = props.action as SurfaceAction;
  const handle = actionHandleFor?.(action);
  const questionId = `surface-${artifact.id}-question`;
  const toggle = (value: string) => {
    setSelected((previous) =>
      previous.includes(value) ? previous.filter((item) => item !== value) : [...previous, value]
    );
  };
  const submit = () => {
    setSubmitted(true);
    if (handle) void onInteraction?.(handle, { ...action.payload, values: selected });
  };

  return (
    <section data-surface-multi-choice aria-labelledby={questionId}>
      <header data-surface-choices-header>
        <span data-surface-eyebrow>Select any</span>
        <h3 id={questionId}>{String(props.question)}</h3>
      </header>
      <div data-surface-choice-list>
        {choices.map((choice) => (
          <label key={choice.value} data-surface-checkbox>
            <input
              type="checkbox"
              disabled={submitted}
              checked={selected.includes(choice.value)}
              onChange={() => toggle(choice.value)}
            />
            <span>{choice.label}</span>
          </label>
        ))}
      </div>
      <footer data-surface-form-footer>
        <button
          type="button"
          disabled={submitted || !handle || selected.length === 0}
          data-surface-button
          data-variant="primary"
          onClick={submit}
        >
          <span>Submit</span>
        </button>
      </footer>
    </section>
  );
}

export function SurfaceForm({
  props,
  onInteraction,
  actionHandleFor,
}: {
  readonly props: Record<string, unknown>;
  readonly onInteraction?: SurfaceWebProps["onInteraction"];
  readonly actionHandleFor?: SurfaceWebProps["actionHandleFor"];
}) {
  const formId = useId();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const fields = props.fields as Array<Record<string, unknown>>;
  const action = props.action as SurfaceAction;
  const handle = actionHandleFor?.(action);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (handle) void onInteraction?.(handle, values);
  };
  const update = (name: string, value: unknown) => {
    setValues((previous) => ({ ...previous, [name]: value }));
  };

  return (
    <form data-surface-form onSubmit={submit}>
      {/*
        No eyebrow and no field count. A form with inputs and a submit button already says it is an
        ask, and a count of its own fields is a number no reader acts on.
      */}
      <header data-surface-form-header>
        <h3>{typeof props.title === "string" ? props.title : "Provide details"}</h3>
      </header>
      <div data-surface-form-fields>
        {fields.map((field) => {
          const name = String(field.name);
          const fieldId = `${formId}-${name}`;
          const input = String(field.input);
          const label = String(field.label);
          const required = field.required === true;
          const description = typeof field.description === "string" ? field.description : undefined;
          const options = Array.isArray(field.options)
            ? field.options.filter((option): option is string => typeof option === "string")
            : [];

          if (input === "checkbox") {
            return (
              <label key={name} htmlFor={fieldId} data-surface-checkbox>
                <input
                  id={fieldId}
                  name={name}
                  type="checkbox"
                  required={required}
                  onChange={(event) => update(name, event.target.checked)}
                />
                <span>
                  {label}
                  {required ? <small data-surface-required>required</small> : null}
                  {description ? <small data-surface-field-description>{description}</small> : null}
                </span>
              </label>
            );
          }

          if (input === "radio") {
            return (
              <fieldset key={name} data-surface-radio-group>
                <legend data-surface-field-label>
                  {label}
                  {required ? <small data-surface-required>required</small> : null}
                  {description ? <small data-surface-field-description>{description}</small> : null}
                </legend>
                {options.map((option) => (
                  <label key={option} htmlFor={`${fieldId}-${option}`} data-surface-radio>
                    <input
                      id={`${fieldId}-${option}`}
                      name={name}
                      type="radio"
                      value={option}
                      required={required}
                      onChange={() => update(name, option)}
                    />
                    <span>{option}</span>
                  </label>
                ))}
              </fieldset>
            );
          }

          if (input === "multiselect") {
            return (
              <label key={name} htmlFor={fieldId} data-surface-field>
                <span data-surface-field-label>
                  {label}
                  {required ? <small data-surface-required>required</small> : null}
                  {description ? <small data-surface-field-description>{description}</small> : null}
                </span>
                <select
                  id={fieldId}
                  name={name}
                  required={required}
                  multiple
                  onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                    update(
                      name,
                      Array.from(event.target.selectedOptions, (option) => option.value)
                    )
                  }
                >
                  {options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            );
          }

          let control: ReactElement;
          if (input === "textarea") {
            control = (
              <textarea
                id={fieldId}
                name={name}
                required={required}
                rows={4}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                  update(name, event.target.value)
                }
              />
            );
          } else if (input === "select") {
            control = (
              <select
                id={fieldId}
                name={name}
                required={required}
                defaultValue=""
                onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                  update(name, event.target.value)
                }
              >
                <option value="" disabled>
                  Select an option
                </option>
                {options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            );
          } else {
            control = (
              <input
                id={fieldId}
                name={name}
                type={input}
                required={required}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  update(
                    name,
                    input === "number" && event.target.value !== ""
                      ? Number(event.target.value)
                      : event.target.value
                  )
                }
              />
            );
          }

          return (
            <label key={name} htmlFor={fieldId} data-surface-field>
              <span data-surface-field-label>
                {label}
                {required ? <small data-surface-required>required</small> : null}
                {description ? <small data-surface-field-description>{description}</small> : null}
              </span>
              {control}
            </label>
          );
        })}
      </div>
      <footer data-surface-form-footer>
        <ActionButton
          label={String(props.submit)}
          action={action}
          actionHandleFor={actionHandleFor}
          primary
          submit
        />
      </footer>
    </form>
  );
}
