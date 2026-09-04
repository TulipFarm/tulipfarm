import { useEffect, useState } from "react";
import { Moon, Sun } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { applyThemePreference, currentTheme, type ResolvedTheme } from "~/lib/theme";
import { cn } from "~/lib/utils";

/*
 * It flips between light and dark directly — a one-click control cannot express "follow the
 * system", so choosing it is deliberately left to Settings › Appearance, and using this toggle
 * sets an explicit preference.
 */
export function ThemeToggle({
  iconOnly = false,
  className,
}: {
  iconOnly?: boolean;
  className?: string;
}) {
  const [theme, setTheme] = useState<ResolvedTheme>("light");

  useEffect(() => {
    const read = () => setTheme(currentTheme());
    read();
    window.addEventListener("themechange", read);
    return () => window.removeEventListener("themechange", read);
  }, []);

  function toggle() {
    setTheme(applyThemePreference(theme === "dark" ? "light" : "dark"));
  }

  const icon = theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />;

  if (iconOnly) {
    return (
      <Button
        variant="ghost"
        size="icon"
        onClick={toggle}
        aria-label="Toggle dark mode"
        className="size-8 rounded-sm"
      >
        {icon}
      </Button>
    );
  }

  /*
   * Labelled, this only ever sits in a menu beside plain rows like Profile and Sign out, so it is
   * a row too: an outlined button among flat ones reads as a different kind of thing. The caller
   * supplies the row styling because the row is the menu's, not the toggle's. Its name is the
   * state it moves you to, not the one you are in — "Dark" next to a moon in dark mode is a
   * riddle.
   */
  return (
    <button type="button" onClick={toggle} className={cn("text-left", className)}>
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      Switch to {theme === "dark" ? "light" : "dark"}
    </button>
  );
}
