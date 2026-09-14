import type { SurfaceAction, SurfaceArtifact, SurfaceRenderContext } from "./contracts";

export interface SurfaceTextAction {
  readonly label: string;
  readonly handle?: string;
  readonly value?: string;
}

export interface SurfaceTextRender {
  readonly text: string;
  readonly actions: readonly SurfaceTextAction[];
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function action(
  label: string,
  value: string | undefined,
  definition: SurfaceAction,
  context: SurfaceRenderContext
): SurfaceTextAction {
  const handledAction =
    value === undefined ? definition : { ...definition, payload: { ...definition.payload, value } };
  return {
    label,
    ...(context.actionHandleFor === undefined
      ? {}
      : { handle: context.actionHandleFor(handledAction) }),
    ...(value === undefined ? {} : { value }),
  };
}

function rows(columns: readonly string[], records: readonly Record<string, unknown>[]): string {
  return records
    .map((record) => columns.map((column) => `${column}: ${stringify(record[column])}`).join(" | "))
    .join("\n");
}

export function truncateSurfaceText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= 1) return value.slice(0, limit);
  return `${value.slice(0, limit - 1)}…`;
}

export function renderSurfaceText(
  artifact: SurfaceArtifact,
  context: SurfaceRenderContext
): SurfaceTextRender {
  const props = artifact.props as Record<string, unknown>;
  let actions: readonly SurfaceTextAction[] = [];
  let text: string;
  switch (artifact.component.name) {
    case "Heading":
      text = String(props.text);
      break;
    case "Text":
      text = String(props.text);
      break;
    case "Section":
    case "Card":
      text = [props.heading ?? props.title, props.body, props.status]
        .filter((value) => value !== undefined)
        .map(stringify)
        .join("\n");
      break;
    case "Status":
      text = `Status: ${String(props.label)}`;
      break;
    case "Alert":
      text = [props.title, props.message]
        .filter((value) => value !== undefined)
        .map(stringify)
        .join("\n");
      break;
    case "List":
      text = (props.items as string[])
        .map((item, index) => `${props.ordered ? `${index + 1}.` : "-"} ${item}`)
        .join("\n");
      break;
    case "RecordDetail":
      text = [
        props.title,
        ...Object.entries(props.record as Record<string, unknown>).map(
          ([key, value]) => `${key}: ${stringify(value)}`
        ),
      ]
        .filter((value) => value !== undefined)
        .map(String)
        .join("\n");
      break;
    case "RecordTable":
      text = rows(props.columns as string[], props.records as Array<Record<string, unknown>>);
      break;
    case "Actions":
      actions = (props.actions as Array<{ label: string; action: SurfaceAction }>).map(
        ({ label, action: definition }) => action(label, undefined, definition, context)
      );
      text = actions.map((item, index) => `${index + 1}. ${item.label}`).join("\n");
      break;
    case "Choices": {
      const definition = props.action as SurfaceAction;
      actions = (props.choices as Array<{ label: string; value: string }>).map((choice) =>
        action(choice.label, choice.value, definition, context)
      );
      text = [
        String(props.question),
        ...actions.map((item, index) => `${index + 1}. ${item.label}`),
      ].join("\n");
      break;
    }
    case "MultiChoice":
      text = [
        String(props.question),
        ...(props.choices as Array<{ label: string }>).map(
          (choice, index) => `${index + 1}. ${choice.label}`
        ),
        "Reply with the numbers you want.",
      ].join("\n");
      break;
    case "Form":
      text = [
        props.title,
        ...(props.fields as Array<Record<string, unknown>>).map(
          (field) => `${String(field.label)}${field.required === true ? " *" : ""}`
        ),
        String(props.submit),
      ]
        .filter((value) => value !== undefined)
        .map(String)
        .join("\n");
      break;
    case "Divider":
      text = "────────";
      break;
    case "Image":
      text = [props.title, String(props.altText), String(props.url)]
        .filter((value) => value !== undefined)
        .map(String)
        .join("\n");
      break;
    case "Metric":
      text = (
        props.cells as Array<{ label: string; value: unknown; unit?: string; caption?: string }>
      )
        .map((cell) =>
          [cell.label, `${stringify(cell.value)}${cell.unit ? ` ${cell.unit}` : ""}`, cell.caption]
            .filter((value) => value !== undefined)
            .join(": ")
        )
        .join("\n");
      break;
    case "Timeline":
      text = (
        props.entries as Array<{
          label: string;
          timestamp?: string;
          description?: string;
          status?: string;
        }>
      )
        .map((entry) =>
          [entry.label, entry.timestamp, entry.description, entry.status]
            .filter((value) => value !== undefined)
            .join(" — ")
        )
        .join("\n");
      break;
    case "Comparison": {
      const options = props.options as Array<{ id: string; label: string; recommended?: boolean }>;
      const cells = props.cells as Array<{ option: string; criterion: string; value: unknown }>;
      text = (props.criteria as Array<{ id: string; label: string }>)
        .map(
          (criterion) =>
            `${criterion.label}: ${options
              .map((option) => {
                const value = cells.find(
                  (cell) => cell.option === option.id && cell.criterion === criterion.id
                )?.value;
                return `${option.label}${option.recommended ? " (recommended)" : ""}=${stringify(value)}`;
              })
              .join(", ")}`
        )
        .join("\n");
      break;
    }
    case "Breakdown":
      text = (props.segments as Array<{ label: string; value: unknown }>)
        .map((segment) => `${segment.label}: ${stringify(segment.value)}`)
        .join("\n");
      break;
    case "Gauge":
      text = `${String(props.label ?? "Progress")}: ${stringify(props.value)} / ${stringify(props.max)}`;
      break;
    default:
      text = "Presentation unavailable.";
  }
  return { text, actions };
}
