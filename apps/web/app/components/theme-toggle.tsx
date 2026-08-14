import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { applyThemePreference, currentTheme, type ResolvedTheme } from "~/lib/theme";

/*
 * It flips between light and dark directly — a one-click control cannot express "follow the
 * system", so choosing it is deliberately left to Settings › Appearance, and using this toggle
 * sets an explicit preference.
 */
export function ThemeToggle({ iconOnly = false }: { iconOnly?: boolean }) {
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

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={toggle}
      aria-label="Toggle dark mode"
      className="gap-2 rounded-sm"
    >
      {icon}
      {theme === "dark" ? "Light" : "Dark"}
    </Button>
  );
}
