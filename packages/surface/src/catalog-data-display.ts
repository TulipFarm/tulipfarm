import { Type } from "@sinclair/typebox";
import { defineSurfaceComponent, type SurfaceComponentDefinition } from "./contracts";

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

/** The data-display component family shipped in the tsp-1.2-data-display-1 revision. */
export const DATA_DISPLAY_COMPONENTS = [
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
