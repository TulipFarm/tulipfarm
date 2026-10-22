import { Button, type ButtonBlockerFix, type ButtonState } from '@tulipfarm/sprout/button';

export { ActionGroup, jumpTo, useActionControl } from '@tulipfarm/sprout/button';

export type BlockerFix = ButtonBlockerFix;

export type ActionState = ButtonState;

type ActionVariant = 'default' | 'outline' | 'secondary' | 'ghost' | 'destructive';

export function ActionButton({
  state,
  children,
  pendingLabel,
  onClick,
  type = 'button',
  variant,
  size,
}: {
  state: ActionState;
  children: string;
  pendingLabel?: string | undefined;
  onClick?: (() => void) | undefined;
  type?: 'button' | 'submit' | undefined;
  variant?: ActionVariant | undefined;
  size?: 'md' | 'sm' | 'lg' | undefined;
}) {
  return (
    <Button
      state={state}
      pendingLabel={pendingLabel}
      type={type}
      variant={variant ?? null}
      size={size ?? null}
      {...(onClick ? { onClick } : {})}
    >
      {children}
    </Button>
  );
}
