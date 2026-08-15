import { Copy } from "lucide-react";
import { GuideSection } from "~/components/design-guide/guide-section";
import { PriorityBadge, StatusBadge } from "~/components/status-badge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";

export function FoundationsSections() {
  return (
    <>
      <GuideSection
        id="typography"
        title="Typography scale"
        description="Inter carries product UI while JetBrains Mono identifies technical content."
      >
        <div className="space-y-3">
          <p className="text-3xl font-semibold">Display · 32/40</p>
          <p className="text-2xl font-semibold">Heading · 24/32</p>
          <p className="text-xl font-semibold">Title · 20/28</p>
          <p className="text-base">Body · 16/24 — readable product content and instructions.</p>
          <p className="text-sm font-medium">Label · 14/20</p>
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
