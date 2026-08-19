import { Globe, Lock, LockKeyhole } from "lucide-react";

/** What a reader needs to tell apart before they act on a Page. */
export type Visibility = "business" | "own" | "inherited";

const shapes: Record<Visibility, { icon: typeof Globe; label: string; hint: string }> = {
  business: { icon: Globe, label: "Everyone", hint: "Anyone in this business can read this" },
  own: {
    icon: Lock,
    label: "Restricted",
    hint: "Only named people, teams, and roles can read this",
  },
  inherited: {
    icon: LockKeyhole,
    label: "Restricted",
    hint: "Restricted by a parent page or space",
  },
};

/**
 * States whether what you are looking at is open or restricted.
 *
 * Never colour alone: a restricted Page and an open one differ by icon and word, because the
 * consequence of misreading this is publishing something to people who should not see it.
 *
 * `inherited` is a separate shape from `own` even though both read "Restricted" — the difference
 * shows in the hint and the icon, and it matters because you cannot loosen an inherited
 * restriction from the Page that inherits it.
 */
export function VisibilityBadge({
  visibility,
  from,
  compact = false,
}: {
  visibility: Visibility;
  /** The ancestor imposing an inherited restriction, named so it can be found and changed. */
  from?: string | null;
  compact?: boolean;
}) {
  const { icon: Icon, label, hint } = shapes[visibility];
  const title = visibility === "inherited" && from ? `Restricted by ${from}` : hint;

  if (compact) {
    return (
      <span title={title} className="inline-flex items-center text-muted-foreground">
        <Icon aria-hidden className="size-3.5" />
        <span className="sr-only">{title}</span>
      </span>
    );
  }

  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
    >
      <Icon aria-hidden className="size-3.5" />
      <span>{label}</span>
      {visibility === "inherited" && from && (
        <span className="text-muted-foreground">· from {from}</span>
      )}
      <span className="sr-only">{title}</span>
    </span>
  );
}
