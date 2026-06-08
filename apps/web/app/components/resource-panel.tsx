import { Link } from "@remix-run/react";
import type { ReactNode } from "react";

/*
 * Shared terminal-window frame for the Resources pages: a `[ crumbs ]` title bar (ruby brackets,
 * breadcrumb Links) + a faux `$ <command>` line, then a body slot. Mirrors empty-state.tsx so the
 * whole section reads as one terminal. Full-width content (list/detail), unlike the centered states.
 */

export type Crumb = { label: string; to?: string };

export function ResourcePanel({
  crumbs,
  command,
  children,
}: {
  crumbs: Crumb[];
  command: string;
  children: ReactNode;
}) {
  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col px-6 py-10">
      <div className="rounded-sm border border-border bg-card motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
          <span className="font-medium uppercase tracking-[0.2em]">
            <span className="text-primary">[</span>
            {crumbs.map((crumb, i) => (
              <span key={crumb.label}>
                {i > 0 ? <span className="opacity-60"> / </span> : null}
                {crumb.to ? (
                  <Link to={crumb.to} className="hover:text-foreground">
                    {crumb.label}
                  </Link>
                ) : (
                  crumb.label
                )}
              </span>
            ))}
            <span className="text-primary">]</span>
          </span>
          <span aria-hidden className="ml-auto opacity-60">
            tulipfarm
          </span>
        </div>
        <div className="flex flex-col gap-4 px-4 py-6 text-sm">
          <p className="text-muted-foreground">
            <span aria-hidden className="text-primary">
              ${" "}
            </span>
            {command}
          </p>
          {children}
        </div>
      </div>
    </section>
  );
}
