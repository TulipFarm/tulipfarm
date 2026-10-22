import { Button, type ButtonProps } from '@tulipfarm/sprout/button';

/** Bud's launcher: a header button when docked, otherwise a draggable pill tall enough for its avatar and two-line label. */
export function BudLauncher({ docked, ...props }: Omit<ButtonProps, 'size' | 'className'> & { docked: boolean }) {
  if (docked) return <Button {...props} size="md" />;
  return (
    <Button
      {...props}
      size="lg"
      className="h-12 cursor-grab touch-none gap-2 rounded-full ps-2 pe-4 active:cursor-grabbing"
    />
  );
}
