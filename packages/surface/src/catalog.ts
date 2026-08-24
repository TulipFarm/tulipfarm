import { Type } from "@sinclair/typebox";
import { DATA_DISPLAY_COMPONENTS } from "./catalog-data-display";
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
    description: "One or more Records with shared columns.",
    propsSchema: Type.Object({
      columns: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
        minItems: 1,
        maxItems: 20,
      }),
      records: Type.Array(record, { minItems: 1, maxItems: 100 }),
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
          detail: Type.Optional(Type.String({ maxLength: 600 })),
          confidence: Type.Optional(
            Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")])
          ),
        }),
        { minItems: 1, maxItems: 10 }
      ),
      /**
       * The `value` of the choice you are recommending. Omit it when you have no preference: the
       * renderer leads with the recommended option and files the rest under alternatives, so
       * naming one here is you making a recommendation, not a display hint.
       */
      recommend: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      action: SurfaceActionSchema,
    }),
    events: events("choose"),
    examples: [
      {
        question: "Want me to place this restock order?",
        choices: [
          {
            label: "Reorder from cone_king",
            value: "reorder_cone_king",
            detail: "Reorder waffle cones from `cone_king` with lead time `7_days`.",
            confidence: "high",
          },
          {
            label: "Switch to vanilla_madagascar",
            value: "switch_vanilla",
            detail: "Switch vanilla to `vanilla_madagascar` for peak season.",
            confidence: "medium",
          },
        ],
        recommend: "reorder_cone_king",
        action: { event: "restock.choose" },
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
            Type.Literal("multiselect"),
            Type.Literal("radio"),
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
    name: "Divider",
    version: "1.0",
    description: "A visual separator between sections.",
    propsSchema: Type.Object({}),
    events: [],
    examples: [{}],
  }),
  defineSurfaceComponent({
    name: "Image",
    version: "1.0",
    description: "A single image with optional caption.",
    propsSchema: Type.Object({
      url: Type.String({ minLength: 1, maxLength: 2_000 }),
      altText: Type.String({ minLength: 1, maxLength: 300 }),
      title: Type.Optional(Type.String({ maxLength: 300 })),
    }),
    events: [],
    examples: [
      { url: "https://example.com/chart.png", altText: "Revenue chart", title: "This week" },
    ],
  }),
  defineSurfaceComponent({
    name: "MultiChoice",
    version: "1.0",
    description: "A multiple-selection semantic choice.",
    propsSchema: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 500 }),
      choices: Type.Array(
        Type.Object({
          label: Type.String({ minLength: 1, maxLength: 100 }),
          value: Type.String({ minLength: 1, maxLength: 200 }),
        }),
        { minItems: 1, maxItems: 10 }
      ),
      minSelections: Type.Optional(Type.Integer({ minimum: 0 })),
      maxSelections: Type.Optional(Type.Integer({ minimum: 1 })),
      action: SurfaceActionSchema,
    }),
    events: events("choose"),
    examples: [
      {
        question: "Which regions?",
        choices: [
          { label: "US", value: "us" },
          { label: "EU", value: "eu" },
        ],
        action: { event: "regions.choose" },
      },
    ],
  }),

  ...DATA_DISPLAY_COMPONENTS,
] as const satisfies readonly SurfaceComponentDefinition[];

export const SURFACE_CATALOG = Object.freeze(
  Object.fromEntries(
    definitions.map((definition) => [`${definition.name}@${definition.version}`, definition])
  ) as Readonly<Record<string, SurfaceComponentDefinition>>
);

export const SHIPPED_CATALOG_REVISION = "tsp-1.2-data-display-1";

export const SHIPPED_SURFACE_COMPONENTS: readonly SurfaceComponentDefinition[] = Object.freeze([
  ...definitions,
]);

export function surfaceComponentFor(
  name: string,
  version: string
): SurfaceComponentDefinition | undefined {
  return SURFACE_CATALOG[`${name}@${version}`];
}
