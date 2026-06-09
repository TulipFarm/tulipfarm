import { type MetaFunction, NavLink, Outlet } from "@remix-run/react";
import { cn } from "~/lib/utils";

export const meta: MetaFunction = () => [{ title: "Settings · tulipfarm" }];

const tabs = [
  { to: "/settings/secrets", label: "Secrets", end: false },
  { to: "/settings/llm", label: "LLM", end: false },
];

// Layout for the Settings subtree: shared header + tab nav, each child owns its own data + form.
export default function SettingsLayout() {
  return (
    <section className="mx-auto w-full max-w-3xl px-6 py-10">
      <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
        <span className="text-primary">[</span>settings<span className="text-primary">]</span>
      </p>
      <h1 className="mt-2 text-lg font-bold text-foreground">Settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">Instance configuration for this tenant.</p>

      <nav className="mt-6 flex gap-1 border-b border-border">
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

      <div className="mt-6">
        <Outlet />
      </div>
    </section>
  );
}
