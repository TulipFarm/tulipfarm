import { NavLink } from "@remix-run/react";
import { cn } from "~/lib/utils";

/*
 * Tab nav shared by the three Access panes.
 *
 * The split is by the question the reader arrived with, not by the shape of the data behind it.
 * **People** answers "what can Priya do, and how do I change it" — the reason almost everyone opens
 * this page. **Teams** is the shortcut for "these five people all get the same thing". **Check** is
 * the one surface that can say *why* something was refused, so it stays, but it stays last: it is
 * where you go after something went wrong, not where you start.
 *
 * An earlier version led with Groups, which is the storage model rather than anyone's question, and
 * asked for a raw principal id before it would tell you anything.
 *
 * `end` on People so it is not marked active while on a sibling.
 */
const tabs = [
  { to: "/business/access", label: "People", end: true },
  { to: "/business/access/teams", label: "Teams", end: false },
  { to: "/business/access/check", label: "Check", end: false },
];

export function AccessTabs() {
  return (
    <nav className="flex gap-1 border-b border-border">
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) =>
            cn(
              "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
              isActive
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
