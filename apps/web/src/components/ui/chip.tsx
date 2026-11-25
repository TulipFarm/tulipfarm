import type { ComponentProps, ReactNode } from 'react';

type ChipProps = Omit<ComponentProps<'button'>, 'className' | 'style'> & {
  /** A 16px icon or avatar before the text. */
  icon?: ReactNode;
  /** Muted text for a placeholder, such as "Assignee" before anyone is chosen. */
  placeholder?: boolean;
  /** Square and icon only; give it an `aria-label`. */
  square?: boolean;
};

/**
 * A compact property pill, as in Linear's issue composer: an icon and a short value that opens a menu.
 * Pass it as the `render` of a popover or menu trigger.
 */
export function Chip({ icon, placeholder = false, square = false, children, type = 'button', ...props }: ChipProps) {
  return (
    <button
      type={type}
      {...props}
      className={`inline-flex h-7 max-w-60 shrink-0 cursor-default items-center gap-1.5 rounded-md border border-border/80 bg-background text-xs font-medium whitespace-nowrap shadow-xs transition-colors outline-none select-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[popup-open]:bg-muted dark:bg-input/30 dark:hover:bg-input/50 ${square ? 'w-7 justify-center' : 'px-2'} ${placeholder ? 'text-muted-foreground' : 'text-foreground'}`}
    >
      {icon && (
        <span
          aria-hidden="true"
          className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_[data-slot$=avatar]]:[--sprout-avatar-size:1rem] [&_[data-slot$=avatar]]:text-[8px] [&_svg]:size-3.5"
        >
          {icon}
        </span>
      )}
      {children !== undefined && children !== null && <span className="min-w-0 truncate">{children}</span>}
    </button>
  );
}

/** A flat full-width property value for a side panel: no border until hovered. */
export function PropertyChip({
  icon,
  placeholder = false,
  children,
  type = 'button',
  ...props
}: Omit<ChipProps, 'square'>) {
  return (
    <button
      type={type}
      {...props}
      className={`inline-flex h-7 w-full min-w-0 cursor-default items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors outline-none select-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-70 data-[popup-open]:bg-muted ${placeholder ? 'text-muted-foreground' : 'text-foreground'}`}
    >
      {icon && (
        <span
          aria-hidden="true"
          className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_[data-slot$=avatar]]:[--sprout-avatar-size:1rem] [&_[data-slot$=avatar]]:text-[8px] [&_svg]:size-3.5"
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}
