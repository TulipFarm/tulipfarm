import { LockIcon } from '@tulipfarm/sprout/icons';

/** Marks a private or restricted item, such as a repository or channel, beside its name. */
export function PrivateMark({ label = 'Private' }: { label?: string }) {
  return (
    <span title={label} className="inline-flex shrink-0 items-center text-muted-foreground">
      <LockIcon size="sm" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}
