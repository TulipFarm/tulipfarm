import { useState } from "react";
import { GuideSection } from "~/components/design-guide/guide-section";
import { Copy } from "~/components/icons";
import { PriorityBadge, StatusBadge } from "~/components/status-badge";
import { Avatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Segmented, SegmentedButton } from "~/components/ui/segmented";
import { Switch } from "~/components/ui/switch";

const ELEVATION = [
  ["none", "", "Rests on the canvas: input, button, card, table"],
  ["shadow-xs", "shadow-xs", "Raised chip: switch thumb, active segment"],
  ["shadow-md", "shadow-md", "Floats over it: popover, menu, tooltip"],
  ["shadow-lg", "shadow-lg", "Dismissable layer: modal, sheet, palette"],
] as const;

export function FoundationsSections() {
  const [segment, setSegment] = useState("all");
  const [on, setOn] = useState(true);

  return (
    <>
      <GuideSection
        id="typography"
        title="Typography scale"
        description="Inter with optical sizing carries product UI; JetBrains Mono identifies technical content. Every reading size carries negative tracking."
      >
        <div className="space-y-3">
          <p className="text-3xl font-semibold">Display · 32</p>
          <p className="text-2xl font-semibold">Heading · 24</p>
          <p className="text-xl font-semibold">Title · 20</p>
          <p className="text-lg font-semibold">Title small · 17</p>
          <p className="text-base">
            Body · 15, the reading size: prose, chat, and anything typed then read back.
          </p>
          <p className="text-sm font-medium">Label · 13, the chrome size: controls, nav, cells</p>
          <p className="text-xs text-muted-foreground">Caption · 12, metadata</p>
          <p className="font-mono text-xs text-muted-foreground">
            run_01J8M7Q2 · 2026-08-02T10:30Z
          </p>
        </div>
      </GuideSection>

      <GuideSection
        id="actions"
        title="Interactive patterns"
        description="One primary action per view, with secondary and dangerous actions subordinate."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button>Primary action</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Delete</Button>
          <Button disabled>Disabled</Button>
          <Button size="icon" aria-label="Copy example">
            <Copy aria-hidden />
          </Button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Badge>Neutral</Badge>
          <Badge variant="info">Information</Badge>
          <Badge variant="success">Success</Badge>
          <Badge variant="warning">Warning</Badge>
          <Badge variant="danger">Danger</Badge>
          <Badge variant="primary">Primary</Badge>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Badge caps>Developer tools</Badge>
          <Badge caps>4 steps</Badge>
          <Badge caps variant="success">
            New
          </Badge>
          <Badge caps variant="danger">
            Connection error
          </Badge>
        </div>
      </GuideSection>

      <GuideSection
        id="material"
        title="Material & elevation"
        description="Resting chrome carries no shadow at all — it separates on a hairline and a one-step change of ground. Shadow is reserved for things that genuinely float."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {ELEVATION.map(([name, shadow, use]) => (
            <div key={name} className={`rounded-lg border border-border bg-card p-4 ${shadow}`}>
              <p className="font-mono text-xs text-foreground">{name}</p>
              <p className="mt-1 text-xs text-muted-foreground">{use}</p>
            </div>
          ))}
        </div>
      </GuideSection>

      <GuideSection
        id="controls"
        title="Segments, switches, and marks"
        description="A segmented control picks one of a closed set. A switch applies at once. An avatar's colour is a hash of the identity, never a random pick."
      >
        <div className="flex flex-wrap items-center gap-6">
          <Segmented>
            <SegmentedButton selected={segment === "all"} onClick={() => setSegment("all")}>
              All docs
            </SegmentedButton>
            <SegmentedButton selected={segment === "mine"} onClick={() => setSegment("mine")}>
              My docs
            </SegmentedButton>
            <SegmentedButton selected={segment === "shared"} onClick={() => setSegment("shared")}>
              Shared
            </SegmentedButton>
          </Segmented>

          <div className="flex items-center gap-2 text-sm">
            <Switch checked={on} onCheckedChange={setOn} id="guide-switch" />
            <label htmlFor="guide-switch">Dark mode</label>
          </div>

          <div className="flex items-center gap-2">
            {["Priya Raghunathan", "Lena Ortiz", "Sam Okafor", "acme-support"].map((who) => (
              <Avatar key={who} identity={who} />
            ))}
          </div>
        </div>
      </GuideSection>

      <GuideSection
        id="status-priority"
        title="Status & priority systems"
        description="Lifecycle and urgency use separate closed semantic systems."
      >
        <div className="flex flex-wrap gap-2">
          <StatusBadge label="Draft" />
          <StatusBadge label="Running" tone="info" />
          <StatusBadge label="Succeeded" tone="success" />
          <StatusBadge label="Needs attention" tone="warning" />
          <StatusBadge label="Failed" tone="danger" />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <PriorityBadge priority="low" />
          <PriorityBadge priority="medium" />
          <PriorityBadge priority="high" />
          <PriorityBadge priority="critical" />
        </div>
      </GuideSection>
    </>
  );
}
