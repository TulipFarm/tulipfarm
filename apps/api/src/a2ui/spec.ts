/**
 * A2UI declarative generative-UI spec — the agent-facing contract for `render_surface`.
 *
 * The agent emits a JSON component tree; the server compiler (a2ui/compiler.ts) resolves `{path}`
 * bindings against the surface data model and renders it to `tf-*` HTML, which is sanitised and shown
 * in the existing hardened iframe (apps/web/app/lib/a2ui). Component names follow the A2UI v0.9 basic
 * catalog where they overlap (Card/Row/Column/Text/Heading/Button/List/Badge/Alert) and add tulip
 * extensions (MetricCard/DetailView/DataTable/BarChart/LineChart/Form) — each mapped to a `tf-*` tag
 * by the catalog (a2ui/catalog.ts).
 *
 * This is the thin-slice shape: a nested tree with inline data. Full A2UI v0.9 parity (flat-array ops,
 * multiple surfaces, live `updateDataModel`) layers on top later without changing this node shape.
 */

/** A leaf value: a literal, or a binding into the surface data model (`{ path: "/a/b" }`, JSON-pointer). */
export type A2uiValue = string | number | boolean | null | { path: string };

/** A button/form interaction posted back through the `agent` bridge on click/submit. */
export interface A2uiAction {
  event: string;
  payload?: Record<string, unknown>;
}

export type A2uiButtonVariant =
  | "default"
  | "secondary"
  | "outline"
  | "ghost"
  | "destructive"
  | "link";

export type A2uiFormFieldInput =
  | "text"
  | "email"
  | "number"
  | "textarea"
  | "select"
  | "radio"
  | "checkbox"
  | "switch"
  | "date";

export interface A2uiFormField {
  name: string;
  label?: string;
  input: A2uiFormFieldInput;
  value?: A2uiValue;
  options?: Array<{ label: string; value: string }>;
  required?: boolean;
  placeholder?: string;
  immutable?: boolean;
}

interface NodeBase {
  /** Optional stable id; the compiler generates one when absent (used as the fragment-swap anchor). */
  id?: string;
}

export type A2uiNode =
  | (NodeBase & { component: "Card"; children?: A2uiNode[] })
  | (NodeBase & { component: "Row" | "Column" | "Grid"; cols?: number; children?: A2uiNode[] })
  | (NodeBase & { component: "Heading"; text: A2uiValue; variant?: "label" })
  | (NodeBase & {
      component: "Text";
      text: A2uiValue;
      tone?: "muted" | "brand" | "danger";
      size?: "xs" | "sm" | "base";
    })
  | (NodeBase & { component: "Badge"; text: A2uiValue; variant?: "brand" | "danger" | "outline" })
  | (NodeBase & {
      component: "Alert";
      text: A2uiValue;
      title?: A2uiValue;
      tone?: "brand" | "danger";
    })
  | (NodeBase & {
      component: "Button";
      label: A2uiValue;
      variant?: A2uiButtonVariant;
      size?: "sm" | "lg";
      action?: A2uiAction;
    })
  | (NodeBase & {
      component: "MetricCard";
      value: A2uiValue;
      label: A2uiValue;
      delta?: A2uiValue;
      trend?: "up" | "flat" | "down";
    })
  | (NodeBase & { component: "List"; items: Array<{ text: A2uiValue; meta?: A2uiValue }> })
  | (NodeBase & { component: "DetailView"; rows: Array<{ label: A2uiValue; value: A2uiValue }> })
  | (NodeBase & {
      component: "DataTable";
      columns: string[];
      rows: A2uiValue[][];
      sort?: { column: string; direction: "ascending" | "descending" };
    })
  | (NodeBase & {
      component: "BarChart" | "LineChart";
      labels: unknown[] | { path: string };
      datasets: unknown[] | { path: string };
    })
  | (NodeBase & {
      component: "Form";
      action: A2uiAction;
      fields: A2uiFormField[];
      submitLabel?: string;
    })
  | (NodeBase & {
      component: "ForceGraph";
      /** [{ id, label, type? }] — nodes, or a binding to them. */
      nodes: unknown[] | { path: string };
      /** [{ source, target, broken? }] — directed edges, or a binding to them. */
      edges: unknown[] | { path: string };
    });

export type A2uiComponentName = A2uiNode["component"];

/** A renderable surface: a root node (or list of nodes) plus an optional version marker. */
export interface A2uiSpec {
  version?: string;
  root: A2uiNode | A2uiNode[];
}

export type A2uiDataModel = Record<string, unknown>;

/**
 * Tool-facing JSON Schema (AJV). Kept intentionally loose — the recursive component tree is validated
 * structurally by the compiler against the catalog, and its shape is taught to the agent via the tool
 * description + system prompt. Sending a deep recursive `oneOf` to the model is neither necessary nor
 * helpful (and a root-level `anyOf/oneOf` would break OpenAI/Azure tool schemas).
 */
/**
 * Compact component-props reference embedded in the tool descriptions so the model emits a valid spec
 * (the recursive tree is too deep to express as a useful JSON Schema). Keep in sync with `A2uiNode`.
 */
export const A2UI_COMPONENTS_REF =
  'Each node is { "component": Name, ...props }. Components & props: ' +
  "Card{children:[]}; Row|Column|Grid{cols?,children:[]}; Heading{text,variant?:'label'}; " +
  "Text{text,tone?:'muted'|'brand'|'danger',size?:'xs'|'sm'|'base'}; " +
  "Badge{text,variant?:'brand'|'danger'|'outline'}; Alert{text,title?,tone?:'brand'|'danger'}; " +
  "Button{label,variant?,size?:'sm'|'lg',action?:{event,payload?}}; " +
  "MetricCard{value,label,delta?,trend?:'up'|'flat'|'down'}; List{items:[{text,meta?}]}; " +
  "DetailView{rows:[{label,value}]}; " +
  "DataTable{columns:[string],rows:[[value]],sort?:{column,direction:'ascending'|'descending'}}; " +
  "BarChart|LineChart{labels:[string],datasets:[{label,data:[number]}]}; " +
  "Form{action:{event,payload?},submitLabel?,fields:[{name,input:'text'|'email'|'number'|'textarea'|'select'|'radio'|'checkbox'|'switch'|'date',label?,value?,required?,options?:[{label,value}]}]}; " +
  "ForceGraph{nodes:[{id,label,type?}],edges:[{source,target,broken?}]}. " +
  'Every leaf value may be a literal OR a binding { "path": "/key" } resolved against dataModel.';

export const A2UI_SPEC_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["root"],
  properties: {
    version: { type: "string" },
    root: {
      description:
        "A component node, or an array of nodes. Each node is an object with a `component` field " +
        "(Card, Row, Column, Grid, Heading, Text, Badge, Alert, Button, MetricCard, List, " +
        "DetailView, DataTable, BarChart, LineChart, Form, ForceGraph) plus that component's props. Leaf values " +
        'may be literals or `{ "path": "/key" }` bindings into the data model.',
    },
  },
};
