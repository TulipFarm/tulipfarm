import type { IntegrationSummary } from "~/lib/integrations";
import { IntegrationIcon } from "./integration-icon";

const EXAMPLES = [
  {
    names: ["linear"],
    fallback: "linear",
    label: "Updated 23 tasks after the last run",
    position: "xl:right-[8%] xl:top-[15%]",
  },
  {
    names: ["github"],
    fallback: "github",
    label: "Reviewed 14 pull requests before merge",
    position: "xl:bottom-[16%] xl:left-[5%]",
  },
  {
    names: ["slack"],
    fallback: "slack",
    label: "Sent 8 updates to team channels",
    position: "xl:right-[3%] xl:bottom-[12%]",
  },
] as const;

export function IntegrationOverview({ integrations }: { integrations: IntegrationSummary[] }) {
  return (
    <section
      aria-label="Integration capability examples"
      className="relative flex min-h-56 flex-col items-start gap-3 overflow-hidden rounded-2xl bg-[var(--integration-banner)] px-4 pb-5 pt-14 text-[var(--integration-banner-foreground)] xl:block xl:p-0"
    >
      <p className="absolute left-5 top-4 z-10 text-xs font-medium">Example activity</p>
      <div aria-hidden className="pointer-events-none">
        <div className="absolute -left-8 bottom-[-4.5rem] size-40 rounded-full border border-white/55" />
        <div className="absolute left-[9%] top-[14%] size-14 rounded-full border border-white/55" />
        <div className="absolute left-[28%] top-[-2.5rem] size-28 rounded-full border border-white/45" />
        <div className="absolute left-[21%] top-[50%] size-8 rounded-full border border-white/60" />
        <div className="absolute right-[18%] top-[-55%] size-96 rounded-full border-[4rem] border-white/25" />
      </div>
      {EXAMPLES.map((example, index) => {
        const integration =
          integrations.find((item) => example.names.some((name) => name === item.name)) ??
          integrations.find((item) => item.name === example.fallback);
        return (
          <div
            key={example.fallback}
            className={`integration-capability-bubble relative z-10 flex max-w-full items-center gap-3 rounded-full border border-white/70 bg-white/45 py-2.5 pl-2.5 pr-5 backdrop-blur-sm xl:absolute xl:max-w-[46%] ${example.position}`}
            style={{ animationDelay: `${index * -1.7}s` }}
          >
            <IntegrationIcon
              label={integration?.title ?? example.fallback}
              iconSlug={integration?.iconSlug ?? example.fallback}
              iconPath={integration?.iconPath}
              iconColor={integration?.iconColor}
              size="md"
              className="shrink-0 rounded-full"
            />
            <span className="min-w-0 text-sm font-medium">{example.label}</span>
          </div>
        );
      })}
    </section>
  );
}
