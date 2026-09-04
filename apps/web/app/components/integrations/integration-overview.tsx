import type { IntegrationSummary } from "~/lib/integrations";
import { IntegrationIcon } from "./integration-icon";

const EXAMPLES = [
  {
    names: ["jira", "linear"],
    fallback: "jira",
    label: "Updated 23 tasks after the last run",
    position: "right-[8%] top-[12%]",
  },
  {
    names: ["github"],
    fallback: "github",
    label: "Reviewed 14 pull requests before merge",
    position: "bottom-[12%] left-[20%]",
  },
  {
    names: ["slack"],
    fallback: "slack",
    label: "Sent 8 updates to team channels",
    position: "-right-16 bottom-[24%]",
  },
] as const;

export function IntegrationOverview({ integrations }: { integrations: IntegrationSummary[] }) {
  return (
    <section
      aria-label="Integration capability examples"
      className="relative min-h-56 overflow-hidden rounded-2xl bg-[var(--integration-banner)]"
    >
      <div className="absolute -left-8 bottom-[-4.5rem] size-40 rounded-full border border-white/55" />
      <div className="absolute left-[9%] top-[14%] size-14 rounded-full border border-white/55" />
      <div className="absolute left-[28%] top-[-2.5rem] size-28 rounded-full border border-white/45" />
      <div className="absolute left-[21%] top-[50%] size-8 rounded-full border border-white/60" />
      <div className="absolute right-[18%] top-[-55%] size-96 rounded-full border-[4rem] border-white/25" />

      {EXAMPLES.map((example, index) => {
        const integration =
          integrations.find((item) => example.names.some((name) => name === item.name)) ??
          integrations.find((item) => item.name === example.fallback);

        return (
          <div
            key={example.label}
            className={`integration-capability-bubble absolute ${example.position} flex items-center gap-3 rounded-full border border-white/70 bg-white/45 py-2.5 pl-2.5 pr-5 text-[var(--integration-banner-foreground)] backdrop-blur-sm`}
            style={{ animationDelay: `${index * -1.7}s` }}
          >
            <IntegrationIcon
              label={integration?.title ?? example.fallback}
              iconSlug={integration?.iconSlug ?? example.fallback}
              iconPath={integration?.iconPath}
              iconColor={integration?.iconColor}
              size="md"
              className="rounded-full"
            />
            <span className="whitespace-nowrap text-sm font-medium">{example.label}</span>
          </div>
        );
      })}
    </section>
  );
}
