import type { CSSProperties, ReactNode } from 'react';
import { ArrowRightIcon, ArrowUpRightIcon } from '@tulipfarm/sprout/icons';

export type SuggestionTone = 'primary' | 'info' | 'success' | 'warning';

const tiles: Record<SuggestionTone, string> = {
  primary: 'bg-primary-subtle text-primary-text',
  info: 'bg-info-subtle text-info',
  success: 'bg-success-subtle text-success',
  warning: 'bg-warning-subtle text-warning',
};
const washes: Record<SuggestionTone, string> = {
  primary: 'from-primary-subtle',
  info: 'from-info-subtle',
  success: 'from-success-subtle',
  warning: 'from-warning-subtle',
};
const glows: Record<SuggestionTone, string> = {
  primary: 'var(--primary)',
  info: 'var(--info)',
  success: 'var(--success)',
  warning: 'var(--warning)',
};

/** Shared with the sent message, so a chosen card morphs into it during the view transition. */
export const sentPromptTransition = 'chat-sent-prompt';

/** A bento grid: the first card is featured and tall, the last spans the bottom row. */
export function SuggestionGrid({ children }: { children: ReactNode }) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:[&>li:first-child]:row-span-2 sm:[&>li:nth-child(4)]:col-span-2">
      {children}
    </ul>
  );
}

export function SuggestionCard({
  icon,
  kind,
  label,
  trailing,
  tone,
  featured = false,
  index,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  kind: string;
  label: string;
  trailing?: ReactNode;
  tone: SuggestionTone;
  featured?: boolean;
  index: number;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <li
      className="flex motion-safe:animate-in motion-safe:fill-mode-backwards motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-500"
      style={{ animationDelay: `${120 + index * 70}ms` }}
    >
      <button
        type="button"
        disabled={disabled}
        onPointerMove={event => {
          const bounds = event.currentTarget.getBoundingClientRect();
          event.currentTarget.style.setProperty('--spot-x', `${event.clientX - bounds.left}px`);
          event.currentTarget.style.setProperty('--spot-y', `${event.clientY - bounds.top}px`);
        }}
        onClick={event => {
          const card = event.currentTarget;
          card.style.viewTransitionName = sentPromptTransition;
          setTimeout(() => (card.style.viewTransitionName = ''), 1000);
          onClick();
        }}
        style={{ '--spot-color': glows[tone] } as CSSProperties}
        className={`group relative isolate flex w-full cursor-pointer flex-col justify-between gap-6 overflow-hidden rounded-2xl border border-border bg-card p-4 text-left transition-[transform,box-shadow,border-color] duration-300 ease-out hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:translate-y-0 active:scale-[0.99] disabled:pointer-events-none disabled:opacity-60 motion-reduce:transition-none motion-reduce:hover:translate-y-0 ${featured ? `min-h-40 bg-linear-to-br ${washes[tone]} via-card to-card sm:min-h-full sm:p-5` : 'min-h-32'}`}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
          style={{
            background:
              'radial-gradient(220px circle at var(--spot-x, 50%) var(--spot-y, 50%), color-mix(in oklab, var(--spot-color) 14%, transparent), transparent 70%)',
          }}
        />
        {featured && (
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute -right-10 -bottom-12 -z-10 rotate-12 opacity-[0.05] transition-transform duration-500 group-hover:scale-110 group-hover:rotate-6 motion-reduce:transform-none [&_svg]:size-44 ${tiles[tone]} bg-transparent`}
          >
            {icon}
          </span>
        )}
        <span className="flex items-start justify-between gap-3">
          <span
            aria-hidden="true"
            className={`flex items-center justify-center rounded-xl transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6 motion-reduce:transform-none ${tiles[tone]} ${featured ? 'size-12 [&_svg]:size-6' : 'size-9'}`}
          >
            {icon}
          </span>
          <span className="flex items-center gap-2">
            {trailing}
            {!featured && (
              <ArrowUpRightIcon
                size="md"
                aria-hidden="true"
                className="-translate-x-1 translate-y-1 text-muted-foreground opacity-0 transition-[transform,opacity] duration-300 group-hover:translate-x-0 group-hover:translate-y-0 group-hover:opacity-100"
              />
            )}
          </span>
        </span>
        <span className="flex flex-col gap-1">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{kind}</span>
          <span
            className={`font-medium text-balance text-foreground ${featured ? 'text-xl leading-snug sm:text-2xl' : 'text-base'}`}
          >
            {label}
          </span>
          {featured && (
            <span className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary-text">
              Start this
              <ArrowRightIcon
                size="sm"
                aria-hidden="true"
                className="transition-transform duration-300 group-hover:translate-x-1"
              />
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
