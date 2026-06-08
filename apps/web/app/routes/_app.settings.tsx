import type { MetaFunction } from "@remix-run/react";
import { ThemeToggle } from "~/components/theme-toggle";

export const meta: MetaFunction = () => [{ title: "Settings · tulipfarm" }];

export default function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-12">
      <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
        <span className="text-primary">[</span>settings<span className="text-primary">]</span>
      </p>
      <h1 className="mt-2 text-lg font-bold text-foreground">Settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">Instance configuration for this tenant.</p>

      <div className="mt-8 flex items-center justify-between gap-4 border-t border-border py-4">
        <div>
          <p className="text-sm font-medium text-foreground">Appearance</p>
          <p className="text-sm text-muted-foreground">Toggle light / dark mode.</p>
        </div>
        <ThemeToggle />
      </div>
    </div>
  );
}
