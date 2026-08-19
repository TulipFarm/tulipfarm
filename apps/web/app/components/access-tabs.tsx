import { NavLink } from "@remix-run/react";
import { cn } from "~/lib/utils";

/* `end` keeps People inactive on sibling routes. */
const tabs = [
  { to: "/business/access", label: "People", end: true },
  { to: "/business/access/teams", label: "Teams", end: false },
  { to: "/business/access/agents", label: "Agents", end: false },
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
