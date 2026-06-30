import { NavLink } from "@remix-run/react";
import { cn } from "~/lib/utils";

const tabs = [
  { to: "/integrations", label: "Installed", end: true },
  { to: "/integrations/marketplace", label: "Marketplace", end: false },
];

export function IntegrationsTabs() {
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
