import { NavLink } from "@remix-run/react";
import { cn } from "~/lib/utils";

// Tab nav shared by the Installed (/skills) and Marketplace (/skills/marketplace) panes. Mirrors the
// settings tab styling. `end` on Installed so it isn't marked active while on the marketplace route.
const tabs = [
  { to: "/skills", label: "Installed", end: true },
  { to: "/skills/marketplace", label: "Marketplace", end: false },
];

export function SkillsTabs() {
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
