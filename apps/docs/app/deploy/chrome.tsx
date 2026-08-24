"use client";

/** The radio value for a platform no manifest describes. */
export const OTHER = "__other__";

/** The site's lowercase bracketed section label, shared by every section on this route. */
export function SectionLabel({ children }: { children: string }) {
  return <p className="text-xs uppercase tracking-[0.2em] text-fd-muted-foreground">{children}</p>;
}
