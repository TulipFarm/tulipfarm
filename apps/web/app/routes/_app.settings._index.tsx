import { Link } from "@remix-run/react";
import { ChevronRight } from "lucide-react";
import { visibleSettingsGroups } from "~/lib/nav";
import { useSessionUser } from "~/lib/use-session-user";

/**
 * Settings is the one place configuration lives now that the sidebar carries only the work.
 * It is a hub rather than a redirect: every destination behind it has to be visible from
 * somewhere, and a redirect to Profile would hide the other eleven.
 */
export default function SettingsIndex() {
  const user = useSessionUser();
  const groups = visibleSettingsGroups({
    isDev: import.meta.env.DEV,
    visiblePaths: user?.navigation?.visiblePaths,
  });

  return (
    <div className="flex flex-col gap-8">
      {groups.map((group) => (
        <section key={group.heading} className="flex flex-col gap-3">
          <h2 className="text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {group.heading}
          </h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {group.items.map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  className="group flex h-full items-start gap-3 rounded-lg border border-border bg-card p-4 transition-colors duration-150 hover:border-primary/50 hover:bg-accent/40"
                >
                  <item.icon
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground group-hover:text-primary"
                    aria-hidden
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-sm font-medium text-foreground">{item.label}</span>
                    {item.description ? (
                      <span className="text-xs leading-relaxed text-muted-foreground">
                        {item.description}
                      </span>
                    ) : null}
                  </span>
                  <ChevronRight
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground/60"
                    aria-hidden
                  />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
