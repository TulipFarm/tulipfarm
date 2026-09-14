import { SITE_URL } from "@tulipfarm/constants/site";
import { useId } from "react";
import type { TelemetryLevel } from "~/lib/telemetry";
import { cn } from "~/lib/utils";

const LEVELS = [
  {
    level: 0,
    label: "Level 0 — Bootstrap only",
    description: "The mandatory one-time report. No daily reports.",
  },
  {
    level: 1,
    label: "Level 1 — Daily counts",
    description:
      "Bootstrap plus daily totals of users, Resource types, connected Integrations, Skills (including bundled totals), Agents, and Routines.",
  },
  {
    level: 2,
    label: "Level 2 — Daily counts and names (default)",
    description:
      "Level 1 plus Resource type names, connected Integration providers, names of Skills you installed, and Agent names. Names may identify your business.",
  },
] as const;

export function TelemetryDisclosure() {
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>
        TulipFarm sends a mandatory one-time bootstrap report after setup: installation ID, version,
        operating system, architecture, deployment method, first boot time, and your business name,
        website, instance URL, and sanitized Soul repository URL when configured.
      </p>
      <p>
        Reports go to TulipFarm to understand adoption and improve the product. URL credentials,
        query strings, and fragments are removed. Records, messages, prompts, schema contents, and
        secrets are excluded.
      </p>
      <a
        href={`${SITE_URL}/docs/security/telemetry`}
        target="_blank"
        rel="noreferrer"
        className="inline-block rounded-sm underline underline-offset-4 hover:text-foreground"
      >
        Read the telemetry policy
      </a>
    </div>
  );
}

export function TelemetryLevelPicker({
  value,
  maxLevel,
  onChange,
  disabled = false,
}: {
  value: TelemetryLevel;
  maxLevel: TelemetryLevel;
  onChange: (level: TelemetryLevel) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <fieldset className="min-w-0 space-y-2" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium">Reporting level</legend>
      {LEVELS.map(({ level, label, description }) => (
        <label
          key={level}
          className={cn(
            "flex min-h-11 items-start gap-3 rounded-md border p-3 text-sm",
            value === level ? "border-foreground bg-accent/40" : "border-border",
            level > maxLevel || disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
          )}
        >
          <input
            type="radio"
            name={`${id}-level`}
            value={level}
            checked={value === level}
            disabled={level > maxLevel}
            onChange={() => onChange(level)}
            aria-labelledby={`${id}-${level}-label`}
            aria-describedby={`${id}-${level}-description`}
            className="mt-0.5 size-4 shrink-0 accent-primary"
          />
          <span className="min-w-0">
            <span id={`${id}-${level}-label`} className="font-medium">
              {label}
            </span>
            <span id={`${id}-${level}-description`} className="mt-1 block text-muted-foreground">
              {description}
              {level > maxLevel ? " Unavailable: exceeds the deployment limit." : ""}
            </span>
          </span>
        </label>
      ))}
      <p className="text-xs text-muted-foreground">
        Deployment limit: Level {maxLevel}. The deployment environment sets this limit.
      </p>
    </fieldset>
  );
}
