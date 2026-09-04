import { Code2, Database, Palette } from "~/components/icons";
import { Badge } from "~/components/ui/badge";

const STARTER_PACKS = [
  {
    name: "Product design kit",
    description: "Critique, research synthesis, flow mapping, UX copy, and accessibility review.",
    skillCount: 8,
    icon: Palette,
  },
  {
    name: "Frontend engineer",
    description: "Component scaffolding, token sync, browser testing, and bundle review.",
    skillCount: 6,
    icon: Code2,
  },
  {
    name: "Backend and infra",
    description: "API contracts, migrations, log triage, infrastructure review, and data checks.",
    skillCount: 7,
    icon: Database,
  },
] as const;

export function SkillStarterPacks() {
  return (
    <section aria-labelledby="starter-packs-heading" className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h2 id="starter-packs-heading" className="text-base font-medium text-foreground">
          Starter packs
        </h2>
        <Badge variant="neutral">Coming soon</Badge>
      </div>

      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <div className="grid min-w-[54rem] grid-cols-3 gap-3">
          {STARTER_PACKS.map((pack) => (
            <article
              key={pack.name}
              className="flex min-h-40 flex-col rounded-lg border border-border bg-card p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <span className="inline-flex size-8 items-center justify-center rounded-md border border-border text-muted-foreground">
                  <pack.icon className="size-4" />
                </span>
                <span className="text-xs text-muted-foreground">Coming soon</span>
              </div>
              <div className="mt-5">
                <h3 className="text-base font-medium text-foreground">{pack.name}</h3>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">{pack.description}</p>
              </div>
              <p className="mt-auto pt-5 text-xs tabular-nums text-muted-foreground">
                {pack.skillCount} skills
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
