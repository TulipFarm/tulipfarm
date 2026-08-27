import { GuideSection } from "~/components/design-guide/guide-section";
import { IntegrationIcon } from "~/components/integrations/integration-icon";
import { CompanionPanel } from "~/components/onboarding/companion-panel";
import { TulipGrowth, type TulipStage } from "~/components/onboarding/tulip-growth";

const TULIP_STAGES: readonly TulipStage[] = [0, 1, 2, 3];

/**
 * Static specimen Tasks — link, chat, and answer actions — for the Companion panel showcase.
 * Never wired live.
 */
const GUIDE_TASKS = [
  {
    id: "provider-key",
    title: "Plant your model key",
    detail: "Agents need one provider connected before they can do anything.",
    action: { kind: "link" as const, href: "/settings/secrets" },
    blocking: true,
    status: "open" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "checklist-resource",
    title: "Create your first resource type",
    action: { kind: "chat" as const, prompt: "Help me create a resource type." },
    blocking: true,
    status: "open" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "employee-count",
    title: "How many people work here?",
    action: { kind: "answer" as const, field: "employeeCount", sink: "memory" as const },
    blocking: true,
    status: "open" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

const GITHUB_MARK =
  "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12";

export function BrandOnboardingSections() {
  return (
    <>
      <GuideSection
        id="brand-marks"
        title="Brand marks"
        description="Third-party logos, in the brand's own colour. Not every brand ships a mark, so the monogram fallback is a first-class state, and it carries the colour too, because one grey tile among coloured logos reads as a failed image."
      >
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <IntegrationIcon label="GitHub" iconPath={GITHUB_MARK} iconColor="181717" />
            <span className="text-sm">Resolved mark</span>
          </div>
          <div className="flex items-center gap-2">
            <IntegrationIcon label="Slack" iconColor="4A154B" />
            <span className="text-sm">Monogram, curated colour</span>
          </div>
          <div className="flex items-center gap-2">
            <IntegrationIcon label="Acme CRM" />
            <span className="text-sm">Uncurated</span>
          </div>
          <div className="flex items-center gap-2">
            <IntegrationIcon label="Google Workspace" size="sm" iconColor="4285F4" />
            <span className="text-sm">Small</span>
          </div>
        </div>
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
          A brand hex is the one colour that cannot be a token. It belongs to someone else and
          arrives as runtime data. It is never rendered as authored: <code>brandInk</code> clamps
          its OKLCH lightness per canvas, because GitHub&rsquo;s <code>#181717</code> is invisible
          on the dark canvas and a pale brand is invisible on the light one. Both corrections ship
          as custom properties so the <code>dark:</code> variant switches them without JavaScript.
        </p>
      </GuideSection>

      <GuideSection
        id="onboarding"
        title="Onboarding: tulip & Companion"
        description="Growth reports real answered-input count, not decoration. Stage is state, motion is only the transition between stages. The same bloom face, eyes open, is the persistent in-app Companion."
      >
        <div className="flex flex-wrap items-end gap-6">
          {TULIP_STAGES.map((stage) => (
            <div key={stage} className="flex flex-col items-center gap-2">
              <TulipGrowth stage={stage} width={60} height={80} />
              <span className="font-mono text-xs text-muted-foreground">stage {stage}</span>
            </div>
          ))}
        </div>
        <p className="mt-4 max-w-2xl text-sm text-muted-foreground">
          Pre-login (<code>/setup</code>) drives this with answered-question count, no step number
          shown. In-app, stage 3 is fixed. It is the Companion's collapsed glyph, bottom right on{" "}
          <code>sm</code>+ and a top-bar icon below it, with a pulsing dot badge (never a popup)
          when a Task is pending.
        </p>
        <div className="mt-5 max-w-sm rounded-md border border-border bg-card">
          <CompanionPanel
            tasks={GUIDE_TASKS}
            loading={false}
            onDismiss={() => {}}
            onAnswered={() => {}}
            onClose={() => {}}
          />
        </div>
      </GuideSection>
    </>
  );
}
