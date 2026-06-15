/**
 * A2UI catalog — maps each declarative component (spec.ts) to the `tf-*` HTML it compiles to. The
 * output structure mirrors the canonical `tf-*` contract (apps/web/app/lib/a2ui/components.ts and the
 * dev harness showcase) and stays within the iframe sanitizer allowlist: only `tf-*` tags + plain
 * HTML, and only `data-`/`aria-` attributes (field identity rides `data-name`, never name/id). Every
 * agent-controlled value passes through `ctx.text` (resolve binding + HTML-escape) before output.
 */

import { esc, sendAttr } from "./escape";
import type { A2uiFormField, A2uiNode, A2uiValue } from "./spec";

/** Helpers the compiler hands to each catalog entry. */
export interface CompileCtx {
  /** Resolve a value (literal or `{path}` binding) and HTML-escape it; "" for undefined/null. */
  text(v: A2uiValue | undefined): string;
  /** Resolve a value (literal/JSON or `{path}` binding) without escaping — for JSON attribute payloads. */
  raw(v: unknown): unknown;
  /** Compile child nodes to HTML. */
  children(nodes: A2uiNode[] | undefined): string;
}

/** `idAttr` is the per-node ` data-a2ui-id="…"` fragment-swap anchor (already escaped, leading space). */
export type CatalogEntry = (node: A2uiNode, ctx: CompileCtx, idAttr: string) => string;

type Of<C extends A2uiNode["component"]> = Extract<A2uiNode, { component: C }>;
// Row/Column/Grid and BarChart/LineChart each share one union member (a multi-literal discriminant),
// so they need the full set in Extract rather than a single-name `Of<…>` (which would resolve to never).
type GridNode = Extract<A2uiNode, { component: "Row" | "Column" | "Grid" }>;
type ChartNode = Extract<A2uiNode, { component: "BarChart" | "LineChart" }>;

function attr(name: string, value: string | undefined): string {
  return value ? ` ${name}="${esc(value)}"` : "";
}

function gridColsAttr(node: GridNode): string {
  let cols: number | undefined;
  if (node.component === "Column") cols = 1;
  else if (node.component === "Row") cols = node.cols ?? Math.min(node.children?.length ?? 1, 6);
  else cols = node.cols;
  if (cols === undefined) return "";
  const clamped = Math.max(1, Math.min(6, Math.trunc(cols)));
  return ` data-cols="${clamped}"`;
}

function renderField(field: A2uiFormField, ctx: CompileCtx): string {
  const value = ctx.text(field.value);
  const disabled = field.immutable ? " disabled" : "";
  const placeholder = attr("placeholder", field.placeholder);
  const name = ` data-name="${esc(field.name)}"`;
  let control: string;
  switch (field.input) {
    case "textarea":
      control = `<tf-textarea><textarea${name}${placeholder}${disabled}>${value}</textarea></tf-textarea>`;
      break;
    case "select": {
      const options = (field.options ?? [])
        .map((o) => {
          const sel = ctx.text(field.value) === o.value ? " selected" : "";
          return `<option value="${esc(o.value)}"${sel}>${esc(o.label)}</option>`;
        })
        .join("");
      control = `<tf-select><select${name}${disabled}>${options}</select></tf-select>`;
      break;
    }
    case "radio": {
      const options = (field.options ?? [])
        .map((o) => {
          const checked = ctx.text(field.value) === o.value ? " checked" : "";
          return `<label><input type="radio" name="${esc(field.name)}"${name} value="${esc(
            o.value
          )}"${checked}${disabled}> ${esc(o.label)}</label>`;
        })
        .join("");
      control = `<tf-radio-group>${options}</tf-radio-group>`;
      break;
    }
    case "checkbox": {
      const checked = field.value === true ? " checked" : "";
      control = `<tf-checkbox><label><input type="checkbox"${name}${checked}${disabled}> ${esc(
        field.label ?? field.name
      )}</label></tf-checkbox>`;
      break;
    }
    case "switch": {
      const checked = field.value === true ? " checked" : "";
      control = `<tf-switch><label><input type="checkbox"${name}${checked}${disabled}> ${esc(
        field.label ?? field.name
      )}</label></tf-switch>`;
      break;
    }
    case "date":
      control = `<tf-calendar><input type="date"${name}${value ? ` value="${value}"` : ""}${disabled}></tf-calendar>`;
      break;
    default:
      control = `<tf-input><input type="${esc(field.input)}"${name}${
        value ? ` value="${value}"` : ""
      }${placeholder}${disabled}></tf-input>`;
  }
  // checkbox/switch carry their caption inline; others get a label row above the control.
  if (field.input === "checkbox" || field.input === "switch") {
    return `<div data-slot="field">${control}</div>`;
  }
  const req = field.required ? ` <span data-slot="req">*</span>` : "";
  const label = field.label ? `<span data-slot="label">${esc(field.label)}${req}</span>` : "";
  return `<div data-slot="field">${label}${control}</div>`;
}

export const A2UI_CATALOG: Record<A2uiNode["component"], CatalogEntry> = {
  Card: (node, ctx, id) => `<tf-card${id}>${ctx.children((node as Of<"Card">).children)}</tf-card>`,

  Row: (node, ctx, id) => {
    const n = node as GridNode;
    return `<tf-grid${gridColsAttr(n)}${id}>${ctx.children(n.children)}</tf-grid>`;
  },
  Column: (node, ctx, id) => {
    const n = node as GridNode;
    return `<tf-grid${gridColsAttr(n)}${id}>${ctx.children(n.children)}</tf-grid>`;
  },
  Grid: (node, ctx, id) => {
    const n = node as GridNode;
    return `<tf-grid${gridColsAttr(n)}${id}>${ctx.children(n.children)}</tf-grid>`;
  },

  Heading: (node, ctx, id) => {
    const n = node as Of<"Heading">;
    return `<tf-heading${n.variant === "label" ? ` data-variant="label"` : ""}${id}>${ctx.text(
      n.text
    )}</tf-heading>`;
  },

  Text: (node, ctx, id) => {
    const n = node as Of<"Text">;
    return `<tf-text${attr("data-tone", n.tone)}${attr("data-size", n.size)}${id}>${ctx.text(
      n.text
    )}</tf-text>`;
  },

  Badge: (node, ctx, id) => {
    const n = node as Of<"Badge">;
    return `<tf-badge${attr("data-variant", n.variant)}${id}>${ctx.text(n.text)}</tf-badge>`;
  },

  Alert: (node, ctx, id) => {
    const n = node as Of<"Alert">;
    const title = n.title ? `<span data-slot="title">${ctx.text(n.title)}</span>` : "";
    return `<tf-alert${attr("data-tone", n.tone)}${id}>${title}${ctx.text(n.text)}</tf-alert>`;
  },

  Button: (node, ctx, id) => {
    const n = node as Of<"Button">;
    const send = n.action
      ? ` ${sendAttr({ kind: "a2ui-action", event: n.action.event, payload: n.action.payload })}`
      : "";
    return `<tf-button${attr("data-variant", n.variant)}${attr("data-size", n.size)}${send}${id}>${ctx.text(
      n.label
    )}</tf-button>`;
  },

  MetricCard: (node, ctx, id) => {
    const n = node as Of<"MetricCard">;
    const delta = n.delta ? `<span data-slot="delta">${ctx.text(n.delta)}</span>` : "";
    return `<tf-metric-card${attr("data-trend", n.trend)}${id}><span data-slot="value">${ctx.text(
      n.value
    )}</span><span data-slot="label">${ctx.text(n.label)}</span>${delta}</tf-metric-card>`;
  },

  List: (node, ctx, id) => {
    const n = node as Of<"List">;
    const items = n.items
      .map((it) => {
        const meta = it.meta ? `<span data-slot="meta">${ctx.text(it.meta)}</span>` : "";
        return `<li>${ctx.text(it.text)}${meta}</li>`;
      })
      .join("");
    return `<tf-list${id}><ul>${items}</ul></tf-list>`;
  },

  DetailView: (node, ctx, id) => {
    const n = node as Of<"DetailView">;
    const rows = n.rows
      .map((r) => `<div><dt>${ctx.text(r.label)}</dt><dd>${ctx.text(r.value)}</dd></div>`)
      .join("");
    return `<tf-detail-view${id}><dl>${rows}</dl></tf-detail-view>`;
  },

  DataTable: (node, ctx, id) => {
    const n = node as Of<"DataTable">;
    const head = n.columns
      .map((c) => {
        const sorted = n.sort && n.sort.column === c ? ` aria-sort="${n.sort.direction}"` : "";
        return `<th${sorted}>${esc(c)}</th>`;
      })
      .join("");
    const body = n.rows
      .map((row) => `<tr>${row.map((cell) => `<td>${ctx.text(cell)}</td>`).join("")}</tr>`)
      .join("");
    return `<tf-data-table${id}><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></tf-data-table>`;
  },

  BarChart: (node, ctx, id) => chart("tf-chart-bar", node as ChartNode, ctx, id),
  LineChart: (node, ctx, id) => chart("tf-chart-line", node as ChartNode, ctx, id),

  Form: (node, ctx, id) => {
    const n = node as Of<"Form">;
    const fields = n.fields.map((f) => renderField(f, ctx)).join("");
    const send = sendAttr({ kind: "a2ui-form", event: n.action.event, payload: n.action.payload });
    const submit = `<tf-button ${send}>${esc(n.submitLabel ?? "Submit")}</tf-button>`;
    return `<tf-schema-form${id}>${fields}<p>${submit}</p></tf-schema-form>`;
  },
};

function chart(tag: string, node: ChartNode, ctx: CompileCtx, id: string): string {
  const labels = esc(JSON.stringify(ctx.raw(node.labels) ?? []));
  const datasets = esc(JSON.stringify(ctx.raw(node.datasets) ?? []));
  return `<${tag} data-labels="${labels}" data-datasets="${datasets}"${id}></${tag}>`;
}
