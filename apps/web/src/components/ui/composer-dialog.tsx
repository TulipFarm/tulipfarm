import type { ComponentProps, ReactNode } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import { DialogContent } from '@tulipfarm/sprout/dialog';
import { Switch } from '@tulipfarm/sprout/switch';

/**
 * A dialog for writing something new, as in Linear's issue composer: pinned near the top of the screen,
 * unpadded so its header, body and footer set their own spacing, and wider when expanded.
 */
export function ComposerDialogContent({
  expanded,
  children,
  ...props
}: Omit<ComponentProps<typeof DialogContent>, 'className' | 'size' | 'placement' | 'showCloseButton'> & {
  expanded: boolean;
}) {
  return (
    <DialogContent
      {...props}
      size="split"
      placement="top"
      showCloseButton={false}
      className={`gap-0 ${expanded ? 'sm:max-w-4xl' : 'sm:max-w-2xl'}`}
    >
      {children}
    </DialogContent>
  );
}

/** A small muted label and switch, such as "Create more" beside a dialog's main action. */
export function InlineSwitch({
  label,
  checked,
  change,
  disabled,
}: {
  label: ReactNode;
  checked: boolean;
  change: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex cursor-default items-center gap-2 text-[13px] text-muted-foreground select-none">
      <Switch size="sm" checked={checked} onCheckedChange={change} disabled={disabled} />
      {label}
    </label>
  );
}

/** A compact 32px action button with 13px text, for dense dialogs. */
export function CompactButton(props: Omit<ComponentProps<typeof Button>, 'className' | 'size'>) {
  return <Button {...props} size="sm" className="h-8 px-3 text-[13px]" />;
}

/** A small muted tag, such as the team key in a breadcrumb. */
export function KeyTag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-5 items-center rounded border border-border/80 bg-muted/60 px-1.5 text-[11px] font-medium text-muted-foreground">
      {children}
    </span>
  );
}
