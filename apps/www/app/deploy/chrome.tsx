"use client";

/** The radio value for a platform no manifest describes. */
export const OTHER = "__other__";

export function SectionLabel({ children }: { children: string }) {
  return <p className="text-sm font-medium">{children}</p>;
}
