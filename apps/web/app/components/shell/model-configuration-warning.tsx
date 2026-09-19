import { useEffect, useState } from "react";
import { Link } from "~/components/ui/link";
import { ApiError, type SessionUser } from "~/lib/api";
import { getLlmConfig } from "~/lib/settings";
import { isBusinessAdmin } from "~/lib/use-session-user";

type ConfigurationState = "loading" | "configured" | "missing" | "unavailable" | "forbidden";

export function ModelConfigurationWarning({ user }: { user?: SessionUser }) {
  const canReadConfiguration =
    isBusinessAdmin(user) &&
    (user?.navigation === undefined || user.navigation.visiblePaths.includes("/business/models"));
  const [state, setState] = useState<ConfigurationState>("loading");

  useEffect(() => {
    if (!canReadConfiguration) return;
    let active = true;
    let pending = false;
    let forbidden = false;
    async function refresh() {
      if (forbidden || pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const config = await getLlmConfig();
        if (active) {
          setState(
            Object.values(config.tiers ?? {}).some((tier) => tier.providers.length > 0)
              ? "configured"
              : "missing"
          );
        }
      } catch (error) {
        forbidden = error instanceof ApiError && (error.status === 401 || error.status === 403);
        if (active) setState(forbidden ? "forbidden" : "unavailable");
      } finally {
        pending = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [canReadConfiguration]);

  if (
    !canReadConfiguration ||
    state === "loading" ||
    state === "configured" ||
    state === "forbidden"
  ) {
    return null;
  }
  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-muted px-3 py-2 text-xs sm:px-4"
    >
      <span>
        {state === "missing"
          ? "No model is configured. Chat and routines that use a model cannot run."
          : "Model configuration could not be checked."}
      </span>
      <Link to="/business/models" className="font-medium underline underline-offset-2">
        {state === "missing" ? "Configure a model" : "Check model settings"}
      </Link>
    </div>
  );
}
