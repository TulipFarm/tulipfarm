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

const metricCell = Type.Object({
  label: Type.String({
    minLength: 1,
    maxLength: 120,
    description: "Human-readable label for this metric cell.",
  }),
  value: Type.Union([Type.Number(), Type.String({ minLength: 1, maxLength: 120 })], {
    description: "Primary numeric or compact textual value to emphasize.",
  }),
  unit: Type.Optional(
    Type.String({ maxLength: 40, description: "Unit suffix, such as %, ms, hours, or seats." })
  ),
  delta: Type.Optional(
    Type.Object({
      value: Type.Union([Type.Number(), Type.String({ minLength: 1, maxLength: 80 })], {
        description: "Change from the comparison period or baseline.",
      }),
      direction: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("flat")], {
        description: "Direction of change so renderers can apply semantic tinting.",
      }),
      label: Type.Optional(
        Type.String({
          maxLength: 100,
          description: "Optional comparison label, such as vs last week.",
        })
      ),
    })
  ),
  caption: Type.Optional(
    Type.String({ maxLength: 240, description: "Short explanatory note below the value." })
  ),
});

const timelineEntry = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 200, description: "Event title." }),
  timestamp: Type.Optional(
    Type.String({ maxLength: 120, description: "Date or timestamp for the event." })
  ),
  description: Type.Optional(
    Type.String({ maxLength: 600, description: "One-sentence event detail." })
  ),
  status: Type.Optional(
    Type.String({ maxLength: 100, description: "Compact event status or category label." })
  ),
});

const comparisonOption = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 100, description: "Stable option identifier." }),
  label: Type.String({ minLength: 1, maxLength: 160, description: "Option column label." }),
  recommended: Type.Optional(
    Type.Boolean({ description: "Mark the preferred option when the matrix supports a decision." })
  ),
});

const comparisonCriterion = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 100, description: "Stable criterion identifier." }),
  label: Type.String({ minLength: 1, maxLength: 160, description: "Criterion row label." }),
  description: Type.Optional(
    Type.String({
      maxLength: 300,
      description: "Optional context for how to judge this criterion.",
    })
  ),
});

const comparisonCell = Type.Object({
  option: Type.String({
    minLength: 1,
    maxLength: 100,
    description: "Option id this value belongs to.",
  }),
  criterion: Type.String({
    minLength: 1,
    maxLength: 100,
    description: "Criterion id this value belongs to.",
  }),
  value: Type.Union(
    [Type.Number(), Type.String({ minLength: 1, maxLength: 300 }), Type.Boolean()],
    {
      description: "Displayed value at the option/criterion intersection.",
    }
  ),
  note: Type.Optional(
    Type.String({ maxLength: 300, description: "Optional short rationale for this cell value." })
  ),
});

const breakdownSegment = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 160, description: "Segment label." }),
  value: Type.Number({ minimum: 0, description: "Segment amount before normalization." }),
});

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

  defineSurfaceComponent({
    name: "Metric",
    version: "1.0",
    description: "One stat cell or a row of quantitative stat cells.",
    propsSchema: Type.Object({
      cells: Type.Array(metricCell, {
        minItems: 1,
        maxItems: 8,
        description: "Metric cells to display left-to-right; use one cell for a single KPI.",
      }),
    }),
    events: [],
    examples: [
      {
        cells: [
          {
            label: "Revenue",
            value: 128400,
            unit: "USD",
            delta: { value: "12%", direction: "up", label: "vs last month" },
            caption: "Closed-won bookings",
          },
        ],
      },
    ],
  }),
  defineSurfaceComponent({
    name: "Timeline",
    version: "1.0",
    description: "An ordered sequence of dated or staged events.",
    propsSchema: Type.Object({
      entries: Type.Array(timelineEntry, {
        minItems: 1,
        maxItems: 50,
        description: "Events in display order, usually chronological.",
      }),
    }),
    events: [],
    examples: [
      {
        entries: [
          {
            label: "Contract sent",
            timestamp: "2026-08-09",
            description: "Legal review completed and the renewal packet was sent.",
            status: "Done",
          },
        ],
      },
    ],
  }),
  defineSurfaceComponent({
    name: "Comparison",
    version: "1.0",
    description: "A decision matrix comparing options against criteria.",
    propsSchema: Type.Object({
      options: Type.Array(comparisonOption, {
        minItems: 1,
        maxItems: 8,
        description: "Options shown as columns; mark at most the recommended ones.",
      }),
      criteria: Type.Array(comparisonCriterion, {
        minItems: 1,
        maxItems: 20,
        description: "Criteria shown as rows.",
      }),
      cells: Type.Array(comparisonCell, {
        minItems: 1,
        maxItems: 160,
        description: "Values for option/criterion intersections.",
      }),
    }),
    events: [],
    examples: [
      {
        options: [
          { id: "basic", label: "Basic" },
          { id: "pro", label: "Pro", recommended: true },
        ],
        criteria: [
          { id: "cost", label: "Cost" },
          { id: "coverage", label: "Coverage" },
        ],
        cells: [
          { option: "basic", criterion: "cost", value: "$40" },
          { option: "pro", criterion: "cost", value: "$75" },
          { option: "basic", criterion: "coverage", value: "Core" },
          { option: "pro", criterion: "coverage", value: "Full" },
        ],
      },
    ],
  }),
  defineSurfaceComponent({
    name: "Breakdown",
    version: "1.0",
    description: "A proportional split such as budget, expenses, or allocation.",
    propsSchema: Type.Object({
      segments: Type.Array(breakdownSegment, {
        minItems: 1,
        maxItems: 20,
        description: "Ordered segment amounts; renderers normalize them against total.",
      }),
      total: Type.Optional(
        Type.Number({ minimum: 0, description: "Explicit denominator; defaults to segment sum." })
      ),
      unit: Type.Optional(
        Type.String({
          maxLength: 40,
          description: "Unit suffix for values, such as hours or seats.",
        })
      ),
      currency: Type.Optional(
        Type.String({ maxLength: 12, description: "Currency prefix or code for money values." })
      ),
    }),
    events: [],
    examples: [
      {
        segments: [
          { label: "Payroll", value: 54000 },
          { label: "Tools", value: 8000 },
          { label: "Travel", value: 5000 },
        ],
        currency: "USD",
      },
    ],
  }),
  defineSurfaceComponent({
    name: "Gauge",
    version: "1.0",
    description: "Bounded progress toward a maximum with an optional target marker.",
    propsSchema: Type.Object({
      value: Type.Number({ minimum: 0, description: "Current progress value." }),
      max: Type.Number({ exclusiveMinimum: 0, description: "Upper bound for the gauge." }),
      label: Type.Optional(Type.String({ maxLength: 160, description: "Gauge label." })),
      target: Type.Optional(
        Type.Number({ minimum: 0, description: "Optional target marker within the same scale." })
      ),
      unit: Type.Optional(
        Type.String({ maxLength: 40, description: "Unit suffix, such as %, items, or hours." })
      ),
    }),
    events: [],
    examples: [{ label: "Quota attainment", value: 72, max: 100, target: 90, unit: "%" }],
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
    "Selection guide: Alert is for an outage, degradation, urgent warning, or important success; Status is one compact state; Metric is one or more KPIs; Timeline is ordered events; Comparison is an option-by-criteria decision matrix; Breakdown is a proportional split; Gauge is bounded progress; RecordTable is repeated Records sharing fields; Choices is one mutually exclusive decision; Form is typed multi-field input.",
    'Call present or request_input with {"component":{"name":"ComponentName","version":"1.0","props":{...}}}. The server derives input validation for request_input; do not supply an awaitedSchema.',
    'The component name never contains its version: use "RecordTable", not "RecordTable@1.0".',
    "All component-specific fields belong inside component.props.",
    ...components.map(
      (component) =>
        `- ${component.name} (version ${component.version}): ${component.description} Props: ${JSON.stringify(component.propsSchema)} Example component: ${JSON.stringify({ name: component.name, version: component.version, props: component.examples[0] })}`
    ),
  ].join("\n");
}
