import { Bot, Braces, GitBranch, Hand, Radio, Wrench } from "~/components/icons";
import { Link } from "~/components/ui/link";
import type { RoutineEffectKind } from "~/lib/routines";
import { EFFECT_LABEL, EFFECT_NOUN, EFFECT_ORDER } from "~/lib/routines/facts";

const EFFECT_ICON: Record<RoutineEffectKind, typeof Bot> = {
  tool: Wrench,
  agent: Bot,
  child_routine: GitBranch,
  script: Braces,
  event: Radio,
  human: Hand,
  wait: Bot,
};

/** How many consequences a row spells out before it collapses the rest into a count. */
const VISIBLE = 3;

/**
 * What a Routine can do, as named consequences.
 *
 * Every one carries its word, never the icon alone: an icon whose meaning has to be learned from a
 * legend elsewhere on the page is not a summary, it is a puzzle, and a wrench says nothing about
 * whether the Routine reaches outside this instance. Past three the row states a count and the
 * full list moves into `title`, so nothing is hidden without a cue. The detail page spells each
 * one out against the State that causes it.
 */
export function EffectSummary({ effects }: { effects: readonly RoutineEffectKind[] }) {
  const ordered = EFFECT_ORDER.filter((kind) => effects.includes(kind));
  if (ordered.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">Computes only, touches nothing outside</span>
    );
  }
  const shown = ordered.slice(0, VISIBLE);
  const rest = ordered.length - shown.length;
  const full = ordered.map((kind) => EFFECT_LABEL[kind]).join(", ");
  return (
    <ul className="flex flex-wrap items-center gap-x-2 gap-y-1" title={full}>
      {shown.map((kind) => {
        const Icon = EFFECT_ICON[kind];
        return (
          <li
            key={kind}
            className={`flex items-center gap-1 text-xs ${
              kind === "tool" ? "text-status-warning" : "text-muted-foreground"
            }`}
          >
            <Icon aria-hidden="true" className="size-3.5 shrink-0" />
            <span aria-hidden="true">{EFFECT_NOUN[kind]}</span>
            <span className="sr-only">{EFFECT_LABEL[kind]}</span>
          </li>
        );
      })}
      {rest > 0 ? (
        <li className="text-xs text-muted-foreground">
          <span aria-hidden="true">+{rest} more</span>
          <span className="sr-only">
            and {rest} more:{" "}
            {ordered
              .slice(VISIBLE)
              .map((kind) => EFFECT_LABEL[kind])
              .join(", ")}
          </span>
        </li>
      ) : null}
    </ul>
  );
}

/** The same facts as a sentence, for a detail header where there is room to read them. */
export function EffectSentence({ effects }: { effects: readonly RoutineEffectKind[] }) {
  const ordered = EFFECT_ORDER.filter((kind) => effects.includes(kind));
  if (ordered.length === 0) return <>Computes only, touches nothing outside</>;
  return <>{ordered.map((kind) => EFFECT_LABEL[kind].toLowerCase()).join(", ")}</>;
}

export function RoutineLink({ slug, children }: { slug: string; children: React.ReactNode }) {
  return (
    <Link
      to={`/routines/${encodeURIComponent(slug)}`}
      className="rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      {children}
    </Link>
  );
}
