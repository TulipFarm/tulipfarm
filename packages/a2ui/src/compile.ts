import {
  type A2UIAction,
  type A2UIDataModel,
  type A2UIFormField,
  type A2UINode,
  type A2UISpec,
  type A2UIValue,
  assertSafePresentationData,
  validateA2UISpec,
} from "./schema";

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeA2UI(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ESCAPE[character] ?? character);
}

function sendAttribute(kind: "a2ui-action" | "a2ui-form", action: A2UIAction): string {
  return `data-a2ui-send="${escapeA2UI(
    JSON.stringify({ kind, descriptor: action.descriptor, disabled: action.disabled ?? false })
  )}"`;
}

function isBinding(value: unknown): value is { readonly path: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { path?: unknown }).path === "string"
  );
}

function resolvePath(model: unknown, path: string): unknown {
  let current = model;
  for (const encoded of path.split("/").slice(1)) {
    if (typeof current !== "object" || current === null) return undefined;
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolved(value: unknown, model: A2UIDataModel): unknown {
  return isBinding(value) ? resolvePath(model, value.path) : value;
}

function text(value: unknown, model: A2UIDataModel): string {
  const result = resolved(value, model);
  if (result === undefined || result === null) return "";
  if (typeof result === "object") return escapeA2UI(JSON.stringify(result));
  return escapeA2UI(result);
}

function attr(name: string, value: string | undefined): string {
  return value === undefined ? "" : ` ${name}="${escapeA2UI(value)}"`;
}

function renderField(field: A2UIFormField, model: A2UIDataModel): string {
  const name = ` data-name="${escapeA2UI(field.name)}"`;
  const value = text(field.value, model);
  const disabled = field.immutable ? " disabled" : "";
  const placeholder = attr("placeholder", field.placeholder);
  let control: string;
  switch (field.input) {
    case "textarea":
      control = `<tf-textarea><textarea${name}${placeholder}${disabled}>${value}</textarea></tf-textarea>`;
      break;
    case "select":
      control = `<tf-select><select${name}${disabled}>${(field.options ?? [])
        .map(
          (option) =>
            `<option value="${escapeA2UI(option.value)}"${
              value === option.value ? " selected" : ""
            }>${escapeA2UI(option.label)}</option>`
        )
        .join("")}</select></tf-select>`;
      break;
    case "radio":
      control = `<tf-radio-group>${(field.options ?? [])
        .map(
          (option) =>
            `<label><input type="radio"${name} value="${escapeA2UI(option.value)}"${
              value === option.value ? " checked" : ""
            }${disabled}> ${escapeA2UI(option.label)}</label>`
        )
        .join("")}</tf-radio-group>`;
      break;
    case "checkbox":
    case "switch": {
      const tag = field.input === "switch" ? "tf-switch" : "tf-checkbox";
      const checked = resolved(field.value, model) === true ? " checked" : "";
      control = `<${tag}><label><input type="checkbox"${name}${checked}${disabled}> ${escapeA2UI(
        field.label ?? field.name
      )}</label></${tag}>`;
      break;
    }
    case "date":
      control = `<tf-calendar><input type="date"${name}${
        value ? ` value="${value}"` : ""
      }${disabled}></tf-calendar>`;
      break;
    default:
      control = `<tf-input><input type="${field.input}"${name}${
        value ? ` value="${value}"` : ""
      }${placeholder}${disabled}></tf-input>`;
  }
  if (field.input === "checkbox" || field.input === "switch") {
    return `<div data-slot="field">${control}</div>`;
  }
  const required = field.required ? ` <span data-slot="req">*</span>` : "";
  const label = field.label
    ? `<span data-slot="label">${escapeA2UI(field.label)}${required}</span>`
    : "";
  return `<div data-slot="field">${label}${control}</div>`;
}

export interface CompiledA2UINode {
  readonly id: string;
  readonly html: string;
  readonly leaf: boolean;
}

export interface CompiledA2UISurface {
  readonly html: string;
  readonly nodeIds: readonly string[];
  readonly nodes: readonly CompiledA2UINode[];
}

const CONTAINERS = new Set<A2UINode["component"]>(["Card", "Row", "Column", "Grid"]);

export function compileA2UISurface(
  input: unknown,
  dataModel: A2UIDataModel = {}
): CompiledA2UISurface {
  const spec: A2UISpec = validateA2UISpec(input);
  assertSafePresentationData(dataModel);
  const nodeIds: string[] = [];
  const nodes: CompiledA2UINode[] = [];
  let counter = 0;

  const renderChildren = (children: readonly A2UINode[] | undefined): string =>
    (children ?? []).map(renderNode).join("");

  function renderNode(node: A2UINode): string {
    const id = node.id ?? `a2-${counter++}`;
    nodeIds.push(id);
    const idAttribute = ` data-a2ui-id="${escapeA2UI(id)}"`;
    let html: string;
    switch (node.component) {
      case "Card":
        html = `<tf-card${idAttribute}>${renderChildren(node.children)}</tf-card>`;
        break;
      case "Row":
      case "Column":
      case "Grid": {
        const cols =
          node.component === "Column" ? 1 : (node.cols ?? Math.min(node.children?.length ?? 1, 6));
        html = `<tf-grid data-cols="${cols}"${idAttribute}>${renderChildren(
          node.children
        )}</tf-grid>`;
        break;
      }
      case "Heading":
        html = `<tf-heading${attr("data-variant", node.variant)}${idAttribute}>${text(
          node.text,
          dataModel
        )}</tf-heading>`;
        break;
      case "Text":
        html = `<tf-text${attr("data-tone", node.tone)}${attr(
          "data-size",
          node.size
        )}${idAttribute}>${text(node.text, dataModel)}</tf-text>`;
        break;
      case "Badge":
        html = `<tf-badge${attr("data-variant", node.variant)}${idAttribute}>${text(
          node.text,
          dataModel
        )}</tf-badge>`;
        break;
      case "Alert":
        html = `<tf-alert${attr("data-tone", node.tone)}${idAttribute}>${
          node.title ? `<span data-slot="title">${text(node.title, dataModel)}</span>` : ""
        }${text(node.text, dataModel)}</tf-alert>`;
        break;
      case "Button":
        html = `<tf-button${attr("data-variant", node.variant)}${attr(
          "data-size",
          node.size
        )}${node.action ? ` ${sendAttribute("a2ui-action", node.action)}` : ""}${
          node.action?.disabled ? ' aria-disabled="true"' : ""
        }${idAttribute}>${text(node.label, dataModel)}</tf-button>`;
        break;
      case "MetricCard":
        html = `<tf-metric-card${attr("data-trend", node.trend)}${idAttribute}><span data-slot="value">${text(
          node.value,
          dataModel
        )}</span><span data-slot="label">${text(node.label, dataModel)}</span>${
          node.delta ? `<span data-slot="delta">${text(node.delta, dataModel)}</span>` : ""
        }</tf-metric-card>`;
        break;
      case "List":
        html = `<tf-list${idAttribute}><ul>${node.items
          .map(
            (item) =>
              `<li>${text(item.text, dataModel)}${
                item.meta ? `<span data-slot="meta">${text(item.meta, dataModel)}</span>` : ""
              }</li>`
          )
          .join("")}</ul></tf-list>`;
        break;
      case "DetailView":
        html = `<tf-detail-view${idAttribute}><dl>${node.rows
          .map(
            (row) =>
              `<div><dt>${text(row.label, dataModel)}</dt><dd>${text(
                row.value,
                dataModel
              )}</dd></div>`
          )
          .join("")}</dl></tf-detail-view>`;
        break;
      case "DataTable":
        html = `<tf-data-table${idAttribute}><table><thead><tr>${node.columns
          .map(
            (column) =>
              `<th${
                node.sort?.column === column ? ` aria-sort="${node.sort.direction}"` : ""
              }>${escapeA2UI(column)}</th>`
          )
          .join("")}</tr></thead><tbody>${node.rows
          .map(
            (row) =>
              `<tr>${row
                .map((cell: A2UIValue) => `<td>${text(cell, dataModel)}</td>`)
                .join("")}</tr>`
          )
          .join("")}</tbody></table></tf-data-table>`;
        break;
      case "BarChart":
      case "LineChart": {
        const tag = node.component === "BarChart" ? "tf-chart-bar" : "tf-chart-line";
        html = `<${tag} data-labels="${escapeA2UI(
          JSON.stringify(resolved(node.labels, dataModel) ?? [])
        )}" data-datasets="${escapeA2UI(
          JSON.stringify(resolved(node.datasets, dataModel) ?? [])
        )}"${idAttribute}></${tag}>`;
        break;
      }
      case "Form":
        html = `<tf-schema-form${idAttribute}>${node.fields
          .map((field) => renderField(field, dataModel))
          .join("")}<p><tf-button ${sendAttribute("a2ui-form", node.action)}${
          node.action.disabled ? ' aria-disabled="true"' : ""
        }>${escapeA2UI(node.submitLabel ?? "Submit")}</tf-button></p></tf-schema-form>`;
        break;
      case "ForceGraph":
        html = `<tf-force-graph data-nodes="${escapeA2UI(
          JSON.stringify(resolved(node.nodes, dataModel) ?? [])
        )}" data-edges="${escapeA2UI(
          JSON.stringify(resolved(node.edges, dataModel) ?? [])
        )}"${idAttribute}></tf-force-graph>`;
        break;
    }
    nodes.push({ id, html, leaf: !CONTAINERS.has(node.component) });
    return html;
  }

  const roots = Array.isArray(spec.root) ? spec.root : [spec.root];
  const html = roots.map(renderNode).join("");
  return { html, nodeIds, nodes };
}
