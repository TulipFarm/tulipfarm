import {
  Activity,
  BookOpen,
  Box,
  Cog,
  type Icon,
  MessageSquare,
  Plug,
  Sparkles,
  Workflow,
  Wrench,
} from "~/components/icons";
import type { ActivityEntry } from "~/lib/activity-feed";

/*
 * How one merged timeline entry is drawn. Kept beside the components rather than in `lib/`, which
 * holds no presentation: the feed reader answers what happened, this answers what it looks like.
 */

const FALLBACK_ICON = Box;

const CATEGORY_ICONS: Record<string, Icon> = {
  run: Activity,
  resource: Box,
  chat: MessageSquare,
  routine: Workflow,
  knowledge: BookOpen,
  skill: Wrench,
  connector: Plug,
  job: Cog,
  soul: Sparkles,
};

export function entryIcon(entry: ActivityEntry): Icon {
  return CATEGORY_ICONS[entry.category] ?? FALLBACK_ICON;
}

/**
 * One word per outcome across both feeds. The log says `ok` where a Run says `succeeded`, and two
 * words for one state in adjacent rows read as two different outcomes. `attention_required` is a
 * state name rather than a sentence, so say it the way a person would.
 */
export function entryStatusLabel(entry: ActivityEntry): string {
  if (entry.kind === "log" && entry.status === "ok") return "succeeded";
  return entry.status.replace(/_/g, " ");
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

export function formatClock(iso: string): string {
  return TIME.format(new Date(iso));
}

export function formatFull(iso: string): string {
  return FULL.format(new Date(iso));
}

/** The local calendar day an entry belongs to, as a stable grouping key. */
export function dayKey(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function formatDay(iso: string, now: Date = new Date()): string {
  if (dayKey(iso) === dayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(iso) === dayKey(yesterday)) return "Yesterday";
  return DAY.format(new Date(iso));
}

/**
 * Coarse on purpose. A feed that ticks "12 seconds ago" up to "13 seconds ago" implies it is
 * watching, and between polls it is not.
 */
export function formatAge(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
