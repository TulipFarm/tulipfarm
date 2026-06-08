import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";

type Theme = "light" | "dark";

/*
 * Toggles [data-theme] on <html> and persists to localStorage. The pre-hydration script in
 * root.tsx sets the initial value; here we read it back on mount and on a "themechange" event so
 * multiple instances (sidebar footer + Settings) stay in sync. AC-V1-005.
 */
export function ThemeToggle({ iconOnly = false }: { iconOnly?: boolean }) {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const read = () => {
      const current = document.documentElement.getAttribute("data-theme");
      if (current === "dark" || current === "light") {
        setTheme(current);
      }
    };
    read();
    window.addEventListener("themechange", read);
    return () => window.removeEventListener("themechange", read);
  }, []);

  function toggle() {
    const next: Theme =
      document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
    setTheme(next);
    window.dispatchEvent(new Event("themechange"));
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
