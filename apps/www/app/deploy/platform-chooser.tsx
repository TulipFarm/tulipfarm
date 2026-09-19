"use client";

import { OTHER } from "./chrome";
import type { WizardTarget } from "./model";

export function PlatformChooser({
  targets,
  selected,
  onSelect,
  disabled,
}: {
  targets: WizardTarget[];
  selected: string | null;
  onSelect: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="platform-choices" disabled={disabled}>
      <legend className="sr-only">Where are you deploying?</legend>
      {targets.map((target) => (
        <label key={target.name} className="platform-choice">
          <span className="platform-choice-title">
            <input
              type="radio"
              name="platform"
              value={target.name}
              checked={selected === target.name}
              onChange={() => onSelect(target.name)}
            />
            <span>{target.title}</span>
          </span>
          <span className="platform-description">{target.description}</span>
          <span className="platform-tier">
            {target.tier === "supported" ? "Tested in CI" : "Community guide"}
          </span>
        </label>
      ))}
      <label className="platform-choice platform-other">
        <span className="platform-choice-title">
          <input
            type="radio"
            name="platform"
            value={OTHER}
            checked={selected === OTHER}
            onChange={() => onSelect(OTHER)}
          />
          <span>Somewhere else</span>
        </span>
        <span className="platform-description">
          No matching guide? Give your assistant the deployment instructions to adapt.
        </span>
      </label>
    </fieldset>
  );
}
