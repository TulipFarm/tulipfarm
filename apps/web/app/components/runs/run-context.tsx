import { Link } from "~/components/ui/link";
import type { OperationalRun } from "~/lib/operations";

const RELATION_LABEL = {
  parent: "Parent Run",
  child: "Child Run",
  replayed_from: "Replayed from",
  replay: "Replay Run",
};

export function RunContext({ context }: { context?: OperationalRun["context"] }) {
  if (!context) return null;
  const items: { label: string; title: string; to: string }[] = [];
  if (context.sourceChat) {
    items.push({
      label: "Source Chat",
      title: context.sourceChat.title || "Open Chat",
      to: `/chat/${encodeURIComponent(context.sourceChat.id)}`,
    });
  }
  if (context.agent) {
    items.push({
      label: "Agent",
      title: context.agent.name,
      to: `/agents/${encodeURIComponent(context.agent.name)}`,
    });
  }
  if (context.routine) {
    items.push({
      label: "Routine",
      title: context.routine.name,
      to: `/routines/${encodeURIComponent(context.routine.name)}`,
    });
  }
  for (const run of context.relatedRuns) {
    items.push({
      label: RELATION_LABEL[run.relation],
      title: run.id,
      to: `/runs/${encodeURIComponent(run.id)}`,
    });
  }
  if (!items.length) return null;
  return (
    <section aria-labelledby="run-context" className="min-w-0">
      <h2 id="run-context" className="mb-2 text-xs font-medium">
        Related work
      </h2>
      <dl className="flex min-w-0 flex-wrap gap-x-6 gap-y-3 text-xs">
        {items.map((item) => (
          <div key={`${item.label}:${item.to}`} className="min-w-0 max-w-full">
            <dt className="mb-1 text-muted-foreground">{item.label}</dt>
            <dd className="min-w-0">
              <Link to={item.to} className="rounded-sm text-brand [overflow-wrap:anywhere]">
                {item.title}
              </Link>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
