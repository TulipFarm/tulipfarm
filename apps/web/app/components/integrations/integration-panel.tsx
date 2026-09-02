import { ArrowUpRight, Check, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { StatusBadge } from "~/components/status-badge";
import { Badge } from "~/components/ui/badge";
import { Link } from "~/components/ui/link";
import { Sheet } from "~/components/ui/sheet";
import { getIntegration, type IntegrationDetail } from "~/lib/integrations";
import { cn } from "~/lib/utils";
import { CONNECTION, displayName, providerHost } from "./integration-card";
import { IntegrationIcon } from "./integration-icon";

/*
 * A preview of one integration, opened from its card without leaving the catalog.
 *
 * It reads, it does not act: connecting is a multi-step flow with credentials and approvals, and
 * running that inside a dismissible sheet gives an operator a way to lose half-entered secrets to a
 * stray backdrop click. Every write stays on the full page, which this always offers a route to.
 */

export function IntegrationPanel({ name, onClose }: { name?: string; onClose: () => void }) {
  const [detail, setDetail] = useState<IntegrationDetail>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!name) return;
    let live = true;
    setDetail(undefined);
    setError(undefined);
    getIntegration(name)
      .then((d) => live && setDetail(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load."));
    return () => {
      live = false;
    };
  }, [name]);

  const title = detail ? displayName(detail) : (name ?? "");
  const soon = detail?.availability === "coming_soon";

  return (
    <Sheet
      open={Boolean(name)}
      onClose={onClose}
      title={`Integrations / ${title}`}
      className="max-w-lg"
      headerActions={
        name && !soon ? (
          <Link
            to={`/integrations/${encodeURIComponent(name)}`}
            aria-label={`Open the full ${title} page`}
            className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowUpRight className="size-4" aria-hidden />
          </Link>
        ) : null
      }
    >
      {!name ? null : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : !detail ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 aria-hidden className="size-4 animate-spin" />
          Loading {title}…
        </p>
      ) : (
        <Body detail={detail} />
      )}
    </Sheet>
  );
}

function Body({ detail }: { detail: IntegrationDetail }) {
  const name = displayName(detail);
  const host = providerHost(detail);
  const soon = detail.availability === "coming_soon";
  const steps = detail.auth ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-3">
        <IntegrationIcon
          label={name}
          iconSlug={detail.iconSlug}
          iconPath={detail.iconPath}
          iconColor={detail.iconColor}
          size="lg"
        />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold text-foreground">{name}</h3>
          {host ? <p className="truncate text-xs text-muted-foreground">By {host}</p> : null}
        </div>
        {soon ? (
          <span className="shrink-0 text-xs text-muted-foreground">Coming soon</span>
        ) : (
          <Link
            to={`/integrations/${encodeURIComponent(detail.name)}`}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-3 py-2",
              "text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            )}
          >
            {detail.status === "connected" ? "Manage" : "Set up"}
            <ArrowUpRight aria-hidden className="size-3.5" />
          </Link>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {detail.category ? <Badge className="capitalize">{detail.category}</Badge> : null}
        {!soon && steps.length > 0 ? (
          <Badge>
            {steps.length} step{steps.length === 1 ? "" : "s"}
          </Badge>
        ) : null}
        {soon ? (
          <StatusBadge label="Not available yet" tone="info" />
        ) : (
          <StatusBadge {...CONNECTION[detail.status]} />
        )}
      </div>

      {detail.description ? (
        <p className="text-sm leading-relaxed text-muted-foreground">{detail.description}</p>
      ) : null}

      {soon ? (
        <Section title="Why it is listed">
          <p className="text-sm leading-relaxed text-muted-foreground">
            This one is on the roadmap, so the catalog names it rather than pretending it does not
            exist. There is no setup to complete yet and no credentials to hand over.
          </p>
        </Section>
      ) : null}

      {detail.capabilities?.length ? (
        <Section title="What agents can do">
          <ul className="flex flex-col gap-2">
            {detail.capabilities.map((c) => (
              <li key={c} className="flex gap-2 text-sm text-muted-foreground">
                <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-primary" />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {detail.grants?.length ? (
        <Section title="Access it hands over">
          <ul className="flex flex-col gap-2">
            {detail.grants.map((g) => (
              <li key={g.label} className="rounded-md border border-border px-3 py-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium text-foreground">
                    {g.label}
                  </span>
                  {g.access ? (
                    <span className="shrink-0 text-xs text-muted-foreground">{g.access}</span>
                  ) : null}
                </div>
                {g.description ? (
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {g.description}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {!soon && steps.length > 0 ? (
        <Section title="Setup">
          <ol className="flex flex-col gap-2">
            {steps.map((step, i) => (
              <li
                key={step.index}
                className="flex items-start gap-3 rounded-md border border-border px-3 py-2.5"
              >
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[0.625rem] font-medium text-muted-foreground tabular-nums">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-medium text-foreground">
                      {step.title ?? step.kind}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 text-[0.625rem] font-medium uppercase tracking-wide",
                        step.satisfied ? "text-primary" : "text-muted-foreground"
                      )}
                    >
                      {step.satisfied ? "Done" : "To do"}
                    </span>
                  </div>
                  {step.description ? (
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {step.description}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 border-t border-border pt-5">
      <h4 className="text-sm font-semibold text-foreground">{title}</h4>
      {children}
    </section>
  );
}
