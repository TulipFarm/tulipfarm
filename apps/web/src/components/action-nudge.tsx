import { useState, type ComponentType } from 'react';
import { X } from 'reicon-react/icons/X';
import { Button } from '@tulipfarm/sprout/button';
import { ButtonGroup } from '@tulipfarm/sprout/button-group';

const storageKey = (id: string) => `tulipfarm:nudge-dismissed:${id}`;

function readDismissed(id: string) {
  try {
    return localStorage.getItem(storageKey(id)) === '1';
  } catch {
    return false;
  }
}

/** Remembers in this browser that a nudge was dismissed, so it never shows again. Scope `id` to the user and workspace. */
export function useNudge(id: string) {
  const [dismissed, setDismissed] = useState(() => readDismissed(id));
  const dismiss = () => {
    try {
      localStorage.setItem(storageKey(id), '1');
    } catch {
      // Still hide it for this visit when the browser blocks storage.
    }
    setDismissed(true);
  };
  return { dismissed, dismiss };
}

/** A dismissible button that suggests one next action, for example in the workspace header. */
export function ActionNudge({
  icon: Icon,
  label,
  onAction,
  onDismiss,
}: {
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean | 'true' }>;
  label: string;
  onAction: () => void;
  onDismiss: () => void;
}) {
  return (
    <ButtonGroup aria-label={label}>
      <Button variant="outline" size="sm" onClick={onAction}>
        <Icon size={14} aria-hidden="true" />
        <span className="@max-md:sr-only">{label}</span>
      </Button>
      <Button variant="outline" size="icon-sm" aria-label={`Dismiss ${label.toLowerCase()}`} onClick={onDismiss}>
        <X size={14} aria-hidden="true" />
      </Button>
    </ButtonGroup>
  );
}
