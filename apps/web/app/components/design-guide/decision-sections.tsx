import { type SurfaceArtifact, surfaceActionKey } from "@tulipfarm/surface/client";
import { SurfaceView } from "@tulipfarm/surface-web/view";
import { GuideSection } from "~/components/design-guide/guide-section";

const ACTION = { event: "restock.choose" };

const CHOICES = [
  {
    label: "Reorder from cone_king",
    value: "reorder",
    detail: "Reorder waffle cones from `cone_king` with lead time `7_days`.",
    confidence: "high",
  },
  {
    label: "Switch to vanilla_madagascar",
    value: "switch",
    detail: "Switch vanilla to `vanilla_madagascar` for peak season.",
    confidence: "medium",
  },
  {
    label: "Full restock across every SKU",
    value: "restock",
    detail: "Fall back to a full restock across every SKU.",
  },
];

const NEUTRAL_ACTION = { event: "environment.choose" };
const NEUTRAL_CHOICES = [
  { label: "Production", value: "production" },
  { label: "Staging", value: "staging" },
];

/** Every choice resolves to a handle. Without one the renderer disables the option, correctly. */
const HANDLES = Object.fromEntries([
  ...CHOICES.map((choice) => [
    surfaceActionKey({ ...ACTION, payload: { value: choice.value } }),
    `guide-${choice.value}`,
  ]),
  ...NEUTRAL_CHOICES.map((choice) => [
    surfaceActionKey({ ...NEUTRAL_ACTION, payload: { value: choice.value } }),
    `guide-${choice.value}`,
  ]),
]);

function choices(id: string, props: Record<string, unknown>): SurfaceArtifact {
  return {
    protocol: "tsp",
    protocolVersion: "1.0",
    id,
    revision: 1,
    component: { name: "Choices", version: "1.0" },
    props: { question: "Want me to place this restock order?", action: ACTION, ...props },
    target: { channel: "web", surface: "chat" },
    audience: ["user:guide"],
    classification: "internal",
    catalogRevision: "tsp-1.2-data-display-1",
    lineage: [],
  };
}

const RECOMMENDED = choices("guide-recommend", { choices: CHOICES, recommend: "reorder" });
const REVIEW = choices("guide-review", { choices: CHOICES, recommend: "switch" });
const NEUTRAL = choices("guide-neutral", {
  question: "Which environment?",
  choices: NEUTRAL_CHOICES,
  action: NEUTRAL_ACTION,
});

function Specimen({ caption, artifact }: { caption: string; artifact: SurfaceArtifact }) {
  return (
    <div>
      <p className="mb-1.5 text-xs text-muted-foreground">{caption}</p>
      <SurfaceView
        artifact={artifact}
        actionHandleFor={(action) => HANDLES[surfaceActionKey(action)]}
        onInteraction={() => undefined}
      />
    </div>
  );
}

export function DecisionSections() {
  return (
    <GuideSection
      id="decisions"
      title="Decisions"
      description="A Choices artifact asks one mutually exclusive question. When the agent names a recommendation the card leads with it in prose, says how sure it is, and files the rest behind Alternatives, so the reader can accept without reading past the first line. When the agent has no preference the same card lists every option at equal weight, because a surface that leads with one option is making a recommendation and must never make one the agent did not. Backticks in the question and detail render as inline code."
    >
      {/* One column: chat renders a single card at full width, and a squeezed specimen would show
          a wrapped footer the reader will never actually see. */}
      <div className="grid gap-6">
        <Specimen
          caption="High confidence, three filled bars, and the primary action names what it will do"
          artifact={RECOMMENDED}
        />
        <Specimen
          caption="Needs review: the same card, a weaker signal, a different lead"
          artifact={REVIEW}
        />
        <Specimen
          caption="No recommendation, every option at equal weight, no drawer, no meter"
          artifact={NEUTRAL}
        />
      </div>
    </GuideSection>
  );
}
