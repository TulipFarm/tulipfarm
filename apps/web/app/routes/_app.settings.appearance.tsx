import { useEffect, useState } from "react";
import type { Icon } from "~/components/icons";
import { Monitor, Moon, Sun } from "~/components/icons";
import { Panel } from "~/components/ui/panel";
import {
  applyThemePreference,
  readThemePreference,
  resolveTheme,
  systemTheme,
  type ThemePreference,
} from "~/lib/theme";
import { cn } from "~/lib/utils";

const OPTIONS: { value: ThemePreference; label: string; icon: Icon; help: string }[] = [
  { value: "system", label: "System", icon: Monitor, help: "Follows your device setting" },
  { value: "light", label: "Light", icon: Sun, help: "Always light" },
  { value: "dark", label: "Dark", icon: Moon, help: "Always dark" },
];

/**
 * Appearance is device-local — it lives in `localStorage`, not on the account, so a shared machine
 * and a personal laptop can differ. Applied immediately on selection; there is nothing to save.
 */
export default function AppearanceSettings() {
  const [preference, setPreference] = useState<ThemePreference>("system");

  useEffect(() => {
    setPreference(readThemePreference());
  }, []);

  function choose(next: ThemePreference) {
    applyThemePreference(next);
    setPreference(next);
  }

  return (
    <Panel
      title="Theme"
      description="Applies to this browser only. Other devices you sign in on keep their own setting."
    >
      <fieldset>
        <legend className="sr-only">Theme</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {OPTIONS.map(({ value, label, icon: Icon, help }) => {
            const selected = preference === value;
            return (
              <label
                key={value}
                className={cn(
                  "flex cursor-pointer flex-col gap-2 rounded-lg border p-3 transition-colors",
                  selected
                    ? "border-primary bg-primary/5"
                    : "border-border bg-card hover:bg-accent/50"
                )}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="theme"
                    value={value}
                    checked={selected}
                    onChange={() => choose(value)}
                    className="size-4 accent-[var(--primary)]"
                  />
                  <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                  <span className="text-sm font-medium text-foreground">{label}</span>
                </span>
                <span className="text-xs text-muted-foreground">{help}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <p className="mt-4 text-xs text-muted-foreground">
        {preference === "system"
          ? `Your device is currently set to ${systemTheme()}.`
          : `Showing the ${resolveTheme(preference)} palette.`}
      </p>
    </Panel>
  );
}
