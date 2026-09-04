"use client";

import { OTHER } from "./chrome";
import type { WizardTarget } from "./model";

export function PlatformChooser({
  targets,
  selected,
  onSelect,
}: {
  targets: WizardTarget[];
  selected: string | null;
  onSelect: (value: string) => void;
}) {
  return (
    <fieldset className="border-y border-fd-border">
      <legend className="sr-only">Where are you deploying?</legend>
      {targets.map((target) => (
        <label
          key={target.name}
          className="group grid cursor-pointer gap-2 border-b border-fd-border border-l-2 border-l-transparent px-3 py-5 transition-colors has-[:checked]:border-l-fd-primary has-[:checked]:bg-fd-accent/60 hover:bg-fd-accent/40 sm:grid-cols-[14rem_1fr] sm:items-baseline sm:gap-5 sm:px-5"
        >
          <span className="flex items-center gap-3">
            <input
              type="radio"
              name="platform"
              value={target.name}
              checked={selected === target.name}
              onChange={() => onSelect(target.name)}
              className="accent-fd-primary"
            />
            <span className="text-sm font-medium">{target.title}</span>
          </span>
          <span className="pl-7 text-sm leading-6 text-fd-muted-foreground sm:pl-0">
            {target.description}
          </span>
        </label>
      ))}
      <label className="group grid cursor-pointer gap-2 border-l-2 border-transparent px-3 py-5 transition-colors has-[:checked]:border-fd-primary has-[:checked]:bg-fd-accent/60 hover:bg-fd-accent/40 sm:grid-cols-[14rem_1fr] sm:items-baseline sm:gap-5 sm:px-5">
        <span className="flex items-center gap-3">
          <input
            type="radio"
            name="platform"
            value={OTHER}
            checked={selected === OTHER}
            onChange={() => onSelect(OTHER)}
            className="accent-fd-primary"
          />
          <span className="text-sm font-medium">Somewhere else</span>
        </span>
        <span className="pl-7 text-sm leading-6 text-fd-muted-foreground sm:pl-0">
          A NAS appliance, a bare virtual machine with no orchestrator, or a platform nobody has
          written down yet. There are no steps to walk, so this hands you the whole prompt.
        </span>
      </label>
    </fieldset>
  );
}
