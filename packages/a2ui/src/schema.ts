import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";

export type A2UIValue = string | number | boolean | null | { path: string };

export interface A2UIAction {
  /** Opaque signed descriptor. The presentation payload never carries action arguments. */
  readonly descriptor: string;
  readonly disabled?: boolean;
}

export type A2UIButtonVariant =
  | "default"
  | "secondary"
  | "outline"
  | "ghost"
  | "destructive"
  | "link";

export type A2UIFormFieldInput =
  | "text"
  | "email"
  | "number"
  | "textarea"
  | "select"
  | "radio"
  | "checkbox"
  | "switch"
  | "date";

export interface A2UIFormField {
  readonly name: string;
  readonly label?: string;
  readonly input: A2UIFormFieldInput;
  readonly value?: A2UIValue;
  readonly options?: readonly { readonly label: string; readonly value: string }[];
  readonly required?: boolean;
  readonly placeholder?: string;
  readonly immutable?: boolean;
}

interface NodeBase {
  readonly id?: string;
}

export type A2UINode =
  | (NodeBase & { readonly component: "Card"; readonly children?: readonly A2UINode[] })
  | (NodeBase & {
      readonly component: "Row" | "Column" | "Grid";
      readonly cols?: number;
      readonly children?: readonly A2UINode[];
    })
  | (NodeBase & {
      readonly component: "Heading";
      readonly text: A2UIValue;
      readonly variant?: "label";
    })
  | (NodeBase & {
      readonly component: "Text";
      readonly text: A2UIValue;
      readonly tone?: "muted" | "brand" | "danger";
      readonly size?: "xs" | "sm" | "base";
    })
  | (NodeBase & {
      readonly component: "Badge";
      readonly text: A2UIValue;
      readonly variant?: "brand" | "danger" | "outline";
    })
  | (NodeBase & {
      readonly component: "Alert";
      readonly text: A2UIValue;
      readonly title?: A2UIValue;
      readonly tone?: "brand" | "danger";
    })
  | (NodeBase & {
      readonly component: "Button";
      readonly label: A2UIValue;
      readonly variant?: A2UIButtonVariant;
      readonly size?: "sm" | "lg";
      readonly action?: A2UIAction;
    })
  | (NodeBase & {
      readonly component: "MetricCard";
      readonly value: A2UIValue;
      readonly label: A2UIValue;
      readonly delta?: A2UIValue;
      readonly trend?: "up" | "flat" | "down";
    })
  | (NodeBase & {
      readonly component: "List";
      readonly items: readonly { readonly text: A2UIValue; readonly meta?: A2UIValue }[];
    })
  | (NodeBase & {
      readonly component: "DetailView";
      readonly rows: readonly {
        readonly label: A2UIValue;
        readonly value: A2UIValue;
      }[];
    })
  | (NodeBase & {
      readonly component: "DataTable";
      readonly columns: readonly string[];
      readonly rows: readonly (readonly A2UIValue[])[];
      readonly sort?: {
        readonly column: string;
        readonly direction: "ascending" | "descending";
      };
    })
  | (NodeBase & {
      readonly component: "BarChart" | "LineChart";
      readonly labels: readonly unknown[] | { readonly path: string };
      readonly datasets: readonly unknown[] | { readonly path: string };
    })
  | (NodeBase & {
      readonly component: "Form";
      readonly action: A2UIAction;
      readonly fields: readonly A2UIFormField[];
      readonly submitLabel?: string;
    })
  | (NodeBase & {
      readonly component: "ForceGraph";
      readonly nodes: readonly unknown[] | { readonly path: string };
      readonly edges: readonly unknown[] | { readonly path: string };
    });

export type A2UIComponentName = A2UINode["component"];

export interface A2UISpec {
  readonly version?: string;
  readonly root: A2UINode | readonly A2UINode[];
}

export type A2UIDataModel = Readonly<Record<string, unknown>>;

const value = {
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string", pattern: "^/" } },
    },
  ],
} as const;

const action = {
  type: "object",
  additionalProperties: false,
  required: ["descriptor"],
  properties: {
    descriptor: { type: "string", minLength: 3 },
    disabled: { type: "boolean" },
  },
} as const;

const baseProperties = { id: { type: "string", minLength: 1, maxLength: 128 } } as const;

function node(
  component: A2UIComponentName | readonly A2UIComponentName[],
  properties: Record<string, unknown>,
  required: readonly string[] = []
): Record<string, unknown> {
  const names = Array.isArray(component) ? component : [component];
  return {
    type: "object",
    additionalProperties: false,
    required: ["component", ...required],
    properties: {
      ...baseProperties,
      component: names.length === 1 ? { const: names[0] } : { enum: names },
      ...properties,
    },
  };
}

const childArray = { type: "array", maxItems: 200, items: { $ref: "#/$defs/node" } };
const arrayOrBinding = {
  anyOf: [
    { type: "array", maxItems: 5_000 },
    {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string", pattern: "^/" } },
    },
  ],
};

const formField = {
  type: "object",
  additionalProperties: false,
  required: ["name", "input"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 128 },
    label: { type: "string", maxLength: 500 },
    input: {
      enum: [
        "text",
        "email",
        "number",
        "textarea",
        "select",
        "radio",
        "checkbox",
        "switch",
        "date",
      ],
    },
    value,
    options: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "value"],
        properties: {
          label: { type: "string", maxLength: 500 },
          value: { type: "string", maxLength: 500 },
        },
      },
    },
    required: { type: "boolean" },
    placeholder: { type: "string", maxLength: 500 },
    immutable: { type: "boolean" },
  },
};

export const A2UI_SPEC_SCHEMA: Record<string, unknown> = {
  $id: "https://tulip.farm/schemas/a2ui/v1",
  type: "object",
  additionalProperties: false,
  required: ["root"],
  properties: {
    version: { type: "string", const: "1" },
    root: {
      anyOf: [
        { $ref: "#/$defs/node" },
        { type: "array", minItems: 1, maxItems: 200, items: { $ref: "#/$defs/node" } },
      ],
    },
  },
  $defs: {
    node: {
      oneOf: [
        node("Card", { children: childArray }),
        node(["Row", "Column", "Grid"], {
          cols: { type: "integer", minimum: 1, maximum: 6 },
          children: childArray,
        }),
        node("Heading", { text: value, variant: { const: "label" } }, ["text"]),
        node(
          "Text",
          {
            text: value,
            tone: { enum: ["muted", "brand", "danger"] },
            size: { enum: ["xs", "sm", "base"] },
          },
          ["text"]
        ),
        node("Badge", { text: value, variant: { enum: ["brand", "danger", "outline"] } }, ["text"]),
        node(
          "Alert",
          {
            text: value,
            title: value,
            tone: { enum: ["brand", "danger"] },
          },
          ["text"]
        ),
        node(
          "Button",
          {
            label: value,
            variant: {
              enum: ["default", "secondary", "outline", "ghost", "destructive", "link"],
            },
            size: { enum: ["sm", "lg"] },
            action,
          },
          ["label"]
        ),
        node(
          "MetricCard",
          {
            value,
            label: value,
            delta: value,
            trend: { enum: ["up", "flat", "down"] },
          },
          ["value", "label"]
        ),
        node(
          "List",
          {
            items: {
              type: "array",
              maxItems: 1_000,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["text"],
                properties: { text: value, meta: value },
              },
            },
          },
          ["items"]
        ),
        node(
          "DetailView",
          {
            rows: {
              type: "array",
              maxItems: 1_000,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["label", "value"],
                properties: { label: value, value },
              },
            },
          },
          ["rows"]
        ),
        node(
          "DataTable",
          {
            columns: {
              type: "array",
              maxItems: 200,
              items: { type: "string", maxLength: 500 },
            },
            rows: {
              type: "array",
              maxItems: 5_000,
              items: { type: "array", maxItems: 200, items: value },
            },
            sort: {
              type: "object",
              additionalProperties: false,
              required: ["column", "direction"],
              properties: {
                column: { type: "string" },
                direction: { enum: ["ascending", "descending"] },
              },
            },
          },
          ["columns", "rows"]
        ),
        node(["BarChart", "LineChart"], { labels: arrayOrBinding, datasets: arrayOrBinding }, [
          "labels",
          "datasets",
        ]),
        node(
          "Form",
          {
            action,
            fields: { type: "array", maxItems: 200, items: formField },
            submitLabel: { type: "string", maxLength: 500 },
          },
          ["action", "fields"]
        ),
        node("ForceGraph", { nodes: arrayOrBinding, edges: arrayOrBinding }, ["nodes", "edges"]),
      ],
    },
  },
};

export const A2UI_COMPONENTS_REF =
  "Allowlisted A2UI v1 components: Card, Row, Column, Grid, Heading, Text, Badge, Alert, " +
  "Button, MetricCard, List, DetailView, DataTable, BarChart, LineChart, Form, ForceGraph. " +
  "Button and Form actions accept only {descriptor}, an opaque server-signed token. " +
  "HTML, JavaScript, event handlers, credentials, and inline business logic are not accepted.";

const ajv = new Ajv({ allErrors: true, strict: true });
const check: ValidateFunction<A2UISpec> = ajv.compile<A2UISpec>(A2UI_SPEC_SCHEMA);

export class A2UISchemaError extends Error {
  readonly name = "A2UISchemaError";

  constructor(readonly issues: readonly string[]) {
    super(`A2UI schema validation failed (${issues.join(", ")})`);
  }
}

function issue(error: ErrorObject): string {
  return `${error.instancePath || "/"} ${error.message ?? "is invalid"}`;
}

export function validateA2UISpec(input: unknown): A2UISpec {
  if (!check(input)) throw new A2UISchemaError((check.errors ?? []).map(issue));
  return input;
}

const PROTECTED_KEY = /(?:^|_)(?:authorization|credential|password|secret|token)(?:$|_)/i;

/** Presentation bindings may carry business data, but never authentication or Secret material. */
export function assertSafePresentationData(input: unknown, path = ""): void {
  if (Array.isArray(input)) {
    input.forEach((value, index) => {
      assertSafePresentationData(value, `${path}/${index}`);
    });
    return;
  }
  if (typeof input !== "object" || input === null) return;
  for (const [key, value] of Object.entries(input)) {
    if (PROTECTED_KEY.test(key)) {
      throw new A2UISchemaError([`${path}/${key} contains protected material`]);
    }
    assertSafePresentationData(value, `${path}/${key}`);
  }
}
