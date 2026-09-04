import type * as React from "react";
import { NavLink } from "~/components/ui/link";
import { cn } from "~/lib/utils";

/**
 * A segmented control: one closed, mutually exclusive set of views over the same subject.
 *
 * It replaces the underline tab bar because an underline is a hairline the reader has to hunt for,
 * while a filled pill says which of the set is showing at a glance. Use it only when every option
 * is present at once and the set is short enough to sit on one line — anything longer, or anything
 * where the options are not alternatives to each other, is navigation and belongs in the sidebar.
 *
 * The active segment is a lifted surface rather than a colour, so the control carries no status or
 * brand meaning of its own.
 */
/**
 * `self-start` is load-bearing. `inline-flex` sizes a control to its content everywhere except
 * inside a flex container — and every page column is one — where the default `align-items:
 * stretch` makes it a full-width flex item instead. That silently stretched every tab strip in
 * the app across the whole content width, which reads as a mobile control rather than a
 * compact set of alternatives.
 */
const TRACK =
  "inline-flex max-w-full self-start items-center gap-0.5 overflow-x-auto rounded-md border border-border bg-muted p-0.5";

const SEGMENT =
  "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-sm px-2.5 text-sm font-medium transition-[color,background-color] pointer-coarse:h-7 [&_svg:not([class*='size-'])]:size-3.5";

const SEGMENT_ACTIVE = "bg-raised text-foreground shadow-xs";
const SEGMENT_IDLE = "text-muted-foreground hover:text-foreground";

/**
 * The container. It is a `<nav>` when its segments are links and a `role="tablist"`-free plain
 * group otherwise: without real `tabpanel`s, claiming the tabs ARIA pattern promises a keyboard
 * contract (arrow-key roving focus) these segments do not implement.
 */
export function Segmented({
  as: As = "div",
  className,
  ...props
}: React.ComponentProps<"div"> & { as?: "div" | "nav" }) {
  return <As className={cn(TRACK, className)} {...props} />;
}

export function SegmentedLink({
  to,
  end,
  className,
  ...props
}: Omit<React.ComponentProps<typeof NavLink>, "className"> & {
  to: string;
  end?: boolean;
  className?: string;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => cn(SEGMENT, isActive ? SEGMENT_ACTIVE : SEGMENT_IDLE, className)}
      {...props}
    />
  );
}

export function SegmentedButton({
  selected,
  className,
  ...props
}: React.ComponentProps<"button"> & { selected: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(SEGMENT, selected ? SEGMENT_ACTIVE : SEGMENT_IDLE, className)}
      {...props}
    />
  );
}
