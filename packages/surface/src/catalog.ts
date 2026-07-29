import { Type } from "@sinclair/typebox";
import {
  defineSurfaceComponent,
  SurfaceActionSchema,
  type SurfaceComponentDefinition,
  type SurfaceTarget,
  targetKey,
} from "./contracts";

const text = Type.String({ minLength: 1, maxLength: 8_000 });
const record = Type.Record(Type.String(), Type.Unknown());
const events = (name: string) => [
  {
    name,
    description: `Handle the semantic ${name} event.`,
    inputSchema: Type.Record(Type.String(), Type.Unknown()),
  },
];

const definitions = [
  defineSurfaceComponent({
    name: "Text",
    version: "1.0",
    description: "Short supporting prose.",
    propsSchema: Type.Object({ text, tone: Type.Optional(Type.String()) }),
    events: [],
    examples: [{ text: "Revenue increased this week." }],
  }),
  defineSurfaceComponent({
    name: "Heading",
    version: "1.0",
    description: "A presentation or section heading.",
    propsSchema: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 300 }),
      level: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
    }),
    events: [],
    examples: [{ text: "Pipeline overview", level: 2 }],
  }),
  defineSurfaceComponent({
    name: "Section",
    version: "1.0",
    description: "A titled semantic section.",
    propsSchema: Type.Object({
      heading: Type.Optional(Type.String({ maxLength: 300 })),
      body: text,
    }),
    events: [],
    examples: [{ heading: "Summary", body: "Three Records need attention." }],
  }),
  defineSurfaceComponent({
    name: "Card",
    version: "1.0",
    description: "A compact titled result card.",
    propsSchema: Type.Object({
      title: Type.Optional(Type.String({ maxLength: 300 })),
      body: text,
      status: Type.Optional(Type.String({ maxLength: 100 })),
    }),
    events: [],
    examples: [{ title: "Acme", body: "Renewal due Friday.", status: "Open" }],
  }),
  defineSurfaceComponent({
    name: "Status",
    version: "1.0",
    description: "A compact state or category.",
    propsSchema: Type.Object({
      label: Type.String({ minLength: 1, maxLength: 100 }),
      tone: Type.Optional(
        Type.Union([
          Type.Literal("neutral"),
          Type.Literal("positive"),
          Type.Literal("warning"),
          Type.Literal("negative"),
        ])
      ),
    }),
    events: [],
    examples: [{ label: "Healthy", tone: "positive" }],
  }),
  defineSurfaceComponent({
    name: "Alert",
    version: "1.0",
    description: "An important informational, warning, or error message.",
    propsSchema: Type.Object({
      title: Type.Optional(Type.String({ maxLength: 300 })),
      message: text,
      severity: Type.Optional(
        Type.Union([
          Type.Literal("info"),
          Type.Literal("warning"),
          Type.Literal("error"),
          Type.Literal("success"),
        ])
      ),
    }),
    events: [],
    examples: [{ title: "Sync delayed", message: "Retrying automatically.", severity: "warning" }],
  }),
  defineSurfaceComponent({
    name: "List",
    version: "1.0",
    description: "A short ordered or unordered list.",
    propsSchema: Type.Object({
      items: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), {
        minItems: 1,
        maxItems: 100,
      }),
      ordered: Type.Optional(Type.Boolean()),
    }),
    events: [],
    examples: [{ items: ["Draft", "Review", "Publish"], ordered: true }],
  }),
  defineSurfaceComponent({
    name: "RecordDetail",
    version: "1.0",
    description: "Labelled fields for one Record.",
    propsSchema: Type.Object({
      title: Type.Optional(Type.String({ maxLength: 300 })),
      record,
    }),
    events: [],
    examples: [{ title: "Acme", record: { status: "Open", owner: "Sam" } }],
  }),
  defineSurfaceComponent({
    name: "RecordTable",
    version: "1.0",
    description: "Two or more Records with shared columns.",
    propsSchema: Type.Object({
      columns: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
        minItems: 1,
        maxItems: 20,
      }),
      records: Type.Array(record, { minItems: 2, maxItems: 100 }),
    }),
    events: [],
    examples: [
      {
        columns: ["name", "status"],
        records: [
          { name: "Acme", status: "Open" },
          { name: "Globex", status: "Won" },
        ],
      },
    ],
  }),
  defineSurfaceComponent({
    name: "Actions",
    version: "1.0",
    description: "One or more semantic actions.",
    propsSchema: Type.Object({
      actions: Type.Array(
        Type.Object({
          label: Type.String({ minLength: 1, maxLength: 100 }),
          action: SurfaceActionSchema,
        }),
        { minItems: 1, maxItems: 10 }
      ),
    }),
    events: events("action"),
    examples: [{ actions: [{ label: "Approve", action: { event: "record.approve" } }] }],
  }),
  defineSurfaceComponent({
    name: "Choices",
    version: "1.0",
    description: "A mutually exclusive semantic choice.",
    propsSchema: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 500 }),
      choices: Type.Array(
        Type.Object({
          label: Type.String({ minLength: 1, maxLength: 100 }),
          value: Type.String({ minLength: 1, maxLength: 200 }),
        }),
        { minItems: 1, maxItems: 10 }
      ),
      action: SurfaceActionSchema,
    }),
    events: events("choose"),
    examples: [
      {
        question: "Which environment?",
        choices: [{ label: "Production", value: "production" }],
        action: { event: "environment.choose" },
      },
    ],
  }),
  defineSurfaceComponent({
    name: "Form",
    version: "1.0",
    description: "Typed structured input.",
    propsSchema: Type.Object({
      title: Type.Optional(Type.String({ maxLength: 300 })),
      fields: Type.Array(
        Type.Object({
          name: Type.String({ minLength: 1, maxLength: 100 }),
          label: Type.String({ minLength: 1, maxLength: 200 }),
          input: Type.Union([
            Type.Literal("text"),
            Type.Literal("email"),
            Type.Literal("number"),
            Type.Literal("textarea"),
            Type.Literal("select"),
            Type.Literal("checkbox"),
            Type.Literal("date"),
          ]),
          required: Type.Optional(Type.Boolean()),
          options: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 100 })),
        }),
        { minItems: 1, maxItems: 50 }
      ),
      submit: Type.String({ minLength: 1, maxLength: 100 }),
      action: SurfaceActionSchema,
    }),
    events: events("submit"),
    examples: [
      {
        fields: [{ name: "email", label: "Email", input: "email", required: true }],
        submit: "Continue",
        action: { event: "contact.submit" },
      },
    ],
  }),
  defineSurfaceComponent({
    name: "Chart",
    version: "1.0",
    description: "A categorical or time-series chart.",
    propsSchema: Type.Object({
      kind: Type.Union([Type.Literal("bar"), Type.Literal("line")]),
      labels: Type.Array(Type.String({ maxLength: 200 }), { minItems: 2, maxItems: 200 }),
      series: Type.Array(
        Type.Object({
          label: Type.String({ maxLength: 200 }),
          values: Type.Array(Type.Number(), { minItems: 2, maxItems: 200 }),
        }),
        { minItems: 1, maxItems: 20 }
      ),
    }),
    events: [],
    examples: [
      { kind: "bar", labels: ["Q1", "Q2"], series: [{ label: "Revenue", values: [4, 7] }] },
    ],
  }),
  defineSurfaceComponent({
    name: "ForceGraph",
    version: "1.0",
    description: "A relationship graph.",
    propsSchema: Type.Object({
      nodes: Type.Array(
        Type.Object({
          id: Type.String({ minLength: 1, maxLength: 200 }),
          label: Type.Optional(Type.String({ maxLength: 300 })),
        }),
        { maxItems: 500 }
      ),
      edges: Type.Array(
        Type.Object({
          source: Type.String({ minLength: 1, maxLength: 200 }),
          target: Type.String({ minLength: 1, maxLength: 200 }),
        }),
        { maxItems: 2_000 }
      ),
    }),
    events: [],
    examples: [
      {
        nodes: [{ id: "acme", label: "Acme" }],
        edges: [],
      },
    ],
  }),
] as const satisfies readonly SurfaceComponentDefinition[];

export const SURFACE_CATALOG = Object.freeze(
  Object.fromEntries(
    definitions.map((definition) => [`${definition.name}@${definition.version}`, definition])
  ) as Readonly<Record<string, SurfaceComponentDefinition>>
);

export const SHIPPED_CATALOG_REVISION = "tsp-1.0-builtins-1";

export const SHIPPED_SURFACE_COMPONENTS: readonly SurfaceComponentDefinition[] = Object.freeze([
  ...definitions,
]);

export function surfaceComponentFor(
  name: string,
  version: string
): SurfaceComponentDefinition | undefined {
  return SURFACE_CATALOG[`${name}@${version}`];
}

export function surfaceCatalogPrompt(
  target: SurfaceTarget,
  components: readonly SurfaceComponentDefinition[],
  revision: string
): string {
  return [
    `Tulip Surface Protocol ${targetKey(target)} catalog (${revision}).`,
    "Prefer a presentation over plain prose when the response contains structured Records, statuses, an important warning, a comparison, actions, choices, or typed input.",
    "Use at most one brief prose lead-in followed by one presentation. Do not repeat its contents.",
    "Only use the listed components. Props must match the selected component schema.",
    "Use present only for non-blocking information. If you ask the user to choose, confirm, or enter anything before continuing, you MUST call request_input instead of present.",
    "Choices and Form always use request_input. After a successful presentation Tool call, do not call another presentation Tool or repeat the content in prose.",
    "Selection guide: Alert is for an outage, degradation, urgent warning, or important success; Status is one compact state; RecordTable is repeated Records sharing fields; Choices is one mutually exclusive decision; Form is typed multi-field input.",
    'Call present or request_input with {"component":{"name":"ComponentName","version":"1.0","props":{...}}}. The server derives input validation for request_input; do not supply an awaitedSchema.',
    'The component name never contains its version: use "RecordTable", not "RecordTable@1.0".',
    "All component-specific fields belong inside component.props.",
    ...components.map(
      (component) =>
        `- ${component.name} (version ${component.version}): ${component.description} Props: ${JSON.stringify(component.propsSchema)} Example component: ${JSON.stringify({ name: component.name, version: component.version, props: component.examples[0] })}`
    ),
  ].join("\n");
}
