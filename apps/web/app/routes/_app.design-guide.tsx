import type { MetaFunction } from "@remix-run/react";
import { AgentRunSections } from "~/components/design-guide/agent-run-sections";
import { BrandOnboardingSections } from "~/components/design-guide/brand-onboarding-sections";
import { ColorSections } from "~/components/design-guide/color-sections";
import { ComponentSections } from "~/components/design-guide/component-sections";
import { CompositionSections } from "~/components/design-guide/composition-sections";
import { FarmSections } from "~/components/design-guide/farm-sections";
import { FoundationsSections } from "~/components/design-guide/foundations-sections";
import { GuideSection } from "~/components/design-guide/guide-section";
import { ReferenceSections } from "~/components/design-guide/reference-sections";
import { Badge } from "~/components/ui/badge";
import { Separator } from "~/components/ui/separator";

export const meta: MetaFunction = () => [{ title: "Design guide · tulipfarm" }];

export function clientLoader() {
  if (!import.meta.env.DEV) throw new Response("Not found", { status: 404 });
  return null;
}

const GUIDE_LINKS = [
  ["principles", "Design principles"],
  ["stack", "Tech stack"],
  ["tokens", "Design tokens"],
  ["run-tokens", "Run & data palettes"],
  ["typography", "Typography scale"],
  ["status-priority", "Status & priority systems"],
  ["agent-run", "Agent run vocabulary"],
  ["brand-marks", "Brand marks"],
  ["onboarding", "Onboarding: tulip & Companion"],
  ["farm", "Farm: the tulip field"],
  ["copy-field", "Copyable values"],
  ["hierarchy", "Component hierarchy"],
  ["composition", "Composition patterns"],
  ["actions", "Interactive patterns"],
  ["layout", "Layout system"],
  ["guide-page", "The /design-guide page"],
  ["forms", "Component index"],
  ["files", "File conventions"],
  ["mistakes", "Common mistakes to avoid"],
] as const;

export default function DesignGuideRoute() {
  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-8 sm:px-8">
      <header className="max-w-3xl pb-6">
        <Badge variant="primary">Internal reference</Badge>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">TulipFarm design guide</h1>
        <p className="mt-2 text-base text-muted-foreground">
          The live showcase for tokens, typography, reusable components, and composition patterns.
        </p>
      </header>

      <nav
        aria-label="Design guide sections"
        className="grid gap-1 rounded-md border border-border p-2 sm:grid-cols-2 lg:grid-cols-3"
      >
        {GUIDE_LINKS.map(([id, label], index) => (
          <a
            key={id}
            href={`#${id}`}
            className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <span className="mr-2 font-mono text-xs text-primary">{index + 1}.</span>
            {label}
          </a>
        ))}
      </nav>

      <GuideSection
        id="principles"
        title="Design principles"
        description="Work-surface first, neutral by default, reusable at the correct layer, and accessible in every state."
      >
        <ul className="grid gap-3 text-sm sm:grid-cols-2">
          {[
            "Use one clear primary action per view.",
            "Build hierarchy with type, spacing, and structure.",
            "Reserve coral for brand, selection, focus, and primary action.",
            "Treat keyboard, contrast, motion, and long content as component states.",
          ].map((item) => (
            <li key={item} className="rounded-md border border-border bg-card px-4 py-3">
              {item}
            </li>
          ))}
        </ul>
      </GuideSection>

      <GuideSection
        id="stack"
        title="Tech stack"
        description="Remix SPA, React 19, TypeScript, Tailwind v4, CVA, Lucide, and app-local shadcn-style primitives."
      >
        <p className="max-w-3xl font-mono text-sm text-muted-foreground">
          Remix · React · TypeScript · Tailwind CSS · Vitest · Testing Library
        </p>
      </GuideSection>

      <ColorSections />
      <FoundationsSections />
      <AgentRunSections />
      <BrandOnboardingSections />

      <FarmSections />
      <ComponentSections />
      <CompositionSections />
      <ReferenceSections />

      <Separator />
      <p className="py-6 font-mono text-xs text-muted-foreground">
        Update this page whenever the public component vocabulary changes.
      </p>
    </div>
  );
}
