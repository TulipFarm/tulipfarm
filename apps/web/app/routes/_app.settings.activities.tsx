import { useLoaderData, useRouteError } from "@remix-run/react";
import {
  BookOpen,
  Box,
  Cog,
  type LucideIcon,
  MessageSquare,
  Plug,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useRef, useState } from "react";
import { ErrorState } from "~/components/states";
import { Sheet } from "~/components/ui/sheet";
import { type ActivityItem, listActivities } from "~/lib/activities";
import { ApiError } from "~/lib/api";
import { cn } from "~/lib/utils";

// Category filter chips → endpoint `category` param. `undefined` = no filter (All).
const CATEGORIES: { key?: string; label: string }[] = [
  { key: undefined, label: "All" },
  { key: "resource", label: "Resources" },
  { key: "chat", label: "Chats" },
  { key: "knowledge", label: "Knowledge" },
  { key: "skill", label: "Skills" },
  { key: "connector", label: "Integrations" },
  { key: "job", label: "Jobs" },
  { key: "soul", label: "Soul" },
];

const CATEGORY_ICON: Record<string, LucideIcon> = {
  resource: Box,
  chat: MessageSquare,
  knowledge: BookOpen,
  skill: Wrench,
  connector: Plug,
  job: Cog,
  soul: Sparkles,
};

const PAGE_SIZE = 50;

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export async function clientLoader() {
  return { initial: await listActivities({ limit: PAGE_SIZE }) };
}

export default function SettingsActivities() {
  const { initial } = useLoaderData<typeof clientLoader>();
  const [items, setItems] = useState<ActivityItem[]>(initial.items);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ActivityItem | null>(null);
  // Generation guard: discard a category fetch whose response loses the race to a newer click.
  const requestId = useRef(0);

  async function applyCategory(next: string | undefined): Promise<void> {
    setCategory(next);
    const id = ++requestId.current;
    setLoading(true);
    try {
      const page = await listActivities({ category: next, limit: PAGE_SIZE });
      if (id !== requestId.current) return; // a newer click superseded this one — drop stale data
      setItems(page.items);
      setCursor(page.nextCursor);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }

  async function loadMore(): Promise<void> {
    if (!cursor) return;
    setLoading(true);
    try {
      const page = await listActivities({ category, cursor, limit: PAGE_SIZE });
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Everything that happens in this workspace — records, chats, knowledge, skills, syncs, and
        background jobs.
      </p>

      <nav className="flex flex-wrap gap-1">
        {CATEGORIES.map((c) => {
          const active = c.key === category;
          return (
            <button
              key={c.label}
              type="button"
              onClick={() => applyCategory(c.key)}
              className={cn(
                "cursor-pointer rounded-sm border px-2.5 py-1 text-xs transition-colors",
                active
                  ? "border-primary text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              )}
            >
              {c.label}
            </button>
          );
        })}
      </nav>

      {items.length === 0 ? (
        <p className="rounded-sm border border-border bg-muted/40 px-3 py-6 text-center text-sm text-muted-foreground">
          No activity yet.
        </p>
      ) : (
        <ul className="flex flex-col">
          {items.map((it) => {
            const Icon = CATEGORY_ICON[it.category] ?? Box;
            return (
              <li key={it.id}>
                <button
                  type="button"
                  onClick={() => setSelected(it)}
                  className="flex w-full cursor-pointer items-start gap-3 border-border border-b px-1 py-2.5 text-left transition-colors hover:bg-accent/50"
                >
                  <Icon
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      it.status === "error" ? "text-destructive" : "text-muted-foreground"
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">{it.summary}</span>
                    <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{it.actorType === "system" ? "system" : "user"}</span>
                      <span aria-hidden>·</span>
                      <span>{formatWhen(it.createdAt)}</span>
                      {it.status === "error" ? (
                        <span className="rounded-sm bg-destructive/10 px-1 text-destructive">
                          error
                        </span>
                      ) : null}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {cursor ? (
        <button
          type="button"
          onClick={loadMore}
          disabled={loading}
          className="cursor-pointer self-center rounded-sm border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      ) : null}

      <Sheet
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.summary ?? "Activity"}
      >
        {selected ? (
          <dl className="flex flex-col gap-3">
            <Field label="Action" value={selected.action} />
            <Field label="Category" value={selected.category} />
            <Field label="Actor" value={selected.actorId ?? selected.actorType} />
            <Field
              label="Target"
              value={
                selected.targetType
                  ? `${selected.targetType}: ${selected.targetId ?? "—"}`
                  : (selected.targetId ?? "—")
              }
            />
            <Field label="Status" value={selected.status} />
            <Field label="When" value={new Date(selected.createdAt).toLocaleString()} />
            {Object.keys(selected.metadata).length > 0 ? (
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Details</dt>
                <dd className="mt-1">
                  <pre className="overflow-x-auto rounded-sm border border-border bg-muted/40 p-2 text-xs text-foreground">
                    {JSON.stringify(selected.metadata, null, 2)}
                  </pre>
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </Sheet>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-foreground">{value}</dd>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="settings" status={status} message={message} />;
}
