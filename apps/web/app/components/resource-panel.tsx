import { Link } from "@remix-run/react";
import type { ReactNode } from "react";

export type Crumb = { label: string; to?: string };

export function ResourcePanel({ crumbs, children }: { crumbs: Crumb[]; children: ReactNode }) {
  const ownsPageHeading = crumbs.length === 1 && crumbs[0]?.to === undefined;

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <section className="mx-auto flex w-full max-w-4xl flex-col px-6 py-10">
        <div className="rounded-sm border border-border bg-card motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
          <nav aria-label="Breadcrumb" className="border-b border-border px-4 py-2">
            <ol className="flex items-center gap-1 text-[0.625rem] font-medium uppercase tracking-[0.2em] text-muted-foreground">
              {crumbs.map((crumb, i) => (
                <li key={crumb.label} className="flex items-center gap-1">
                  {i > 0 ? (
                    <span aria-hidden className="opacity-40">
                      /
                    </span>
                  ) : null}
                  {crumb.to ? (
                    <Link to={crumb.to} className="transition-colors hover:text-foreground">
                      {crumb.label}
                    </Link>
                  ) : ownsPageHeading ? (
                    <h1 className="text-[inherit] font-[inherit] text-foreground">{crumb.label}</h1>
                  ) : (
                    <span className="text-foreground">{crumb.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
          <div className="flex flex-col gap-4 px-4 py-6 text-sm">{children}</div>
        </div>
      </section>
    </div>
  );
}
