import { GuideSection } from "~/components/design-guide/guide-section";
import { StatusBadge } from "~/components/status-badge";

export function ReferenceSections() {
  return (
    <>
      <GuideSection
        id="guide-page"
        title="The /design-guide page"
        description="This development-only route renders production components and must change with their public vocabulary."
      >
        <StatusBadge label="Development only" tone="info" />
      </GuideSection>

      <GuideSection
        id="files"
        title="File conventions"
        description="Use app-local primitives, named exports, kebab-case files, type-only imports, CVA variants, and colocated tests."
      >
        <code className="block max-w-3xl rounded-md border border-border bg-muted p-4 font-mono text-sm">
          apps/web/app/components/ui/component.tsx
        </code>
      </GuideSection>

      <GuideSection
        id="mistakes"
        title="Common mistakes to avoid"
        description="Do not introduce raw colors, duplicated controls, all-monospace prose, color-only feedback, tiny targets, or decorative effects."
      >
        <p className="max-w-3xl text-base text-muted-foreground">
          Search for an existing token or component first. If the public vocabulary changes, update
          this page and the repository skill in the same change.
        </p>
      </GuideSection>
    </>
  );
}
