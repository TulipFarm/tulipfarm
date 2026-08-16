/** Interactive blocks: every one collects operator input and posts it back through `onInteraction`. */

import type { SurfaceAction, SurfaceArtifact } from "@tulipfarm/surface";
import type { ChangeEvent, FormEvent, ReactElement } from "react";
import { useId, useState } from "react";
import { ActionButton, type SurfaceWebProps } from "../primitives";

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
  const [selected, setSelected] = useState<string>();
  const choices = props.choices as Array<{ label: string; value: string }>;
  const action = props.action as SurfaceAction;
  const questionId = `surface-${artifact.id}-question`;

  return (
    <section data-surface-choices aria-labelledby={questionId}>
      <header data-surface-choices-header>
        <span data-surface-eyebrow>Select one</span>
        <h3 id={questionId}>{String(props.question)}</h3>
      </header>
      <div data-surface-choice-list>
        {choices.map((choice) => (
          <ActionButton
            key={choice.value}
            label={choice.label}
            action={{ ...action, payload: { ...action.payload, value: choice.value } }}
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
      <header data-surface-panel-header>
        <div data-surface-panel-heading>
          <span data-surface-eyebrow>Input requested</span>
          <h3>{typeof props.title === "string" ? props.title : "Provide details"}</h3>
        </div>
        <span data-surface-panel-meta>
          {fields.length} {fields.length === 1 ? "field" : "fields"}
        </span>
      </header>
      <div data-surface-form-fields>
        {fields.map((field) => {
          const name = String(field.name);
          const fieldId = `${formId}-${name}`;
          const input = String(field.input);
          const label = String(field.label);
          const required = field.required === true;
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
                </span>
              </label>
            );
          }

          if (input === "radio") {
            return (
              <fieldset key={name} data-surface-radio-group>
                <legend>
                  {label}
                  {required ? <small data-surface-required>required</small> : null}
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
                <span>
                  {label}
                  {required ? <small data-surface-required>required</small> : null}
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
              <span>
                {label}
                {required ? <small data-surface-required>required</small> : null}
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
