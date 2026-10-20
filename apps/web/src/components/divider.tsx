export function Divider({ children }: { children: string }) {
  return (
    <div
      role="separator"
      aria-label={children}
      data-slot="divider"
      className="relative flex w-full items-center gap-3 text-xs text-muted-foreground before:h-px before:min-w-0 before:flex-1 before:bg-linear-to-r before:from-transparent before:to-border after:h-px after:min-w-0 after:flex-1 after:bg-linear-to-l after:from-transparent after:to-border"
    >
      <span className="shrink-0">{children}</span>
      <span
        aria-hidden="true"
        data-slot="divider-shine"
        className="pointer-events-none absolute inset-0 flex items-center gap-3 text-foreground opacity-0 before:h-px before:min-w-0 before:flex-1 before:bg-foreground after:h-px after:min-w-0 after:flex-1 after:bg-foreground"
      >
        <span className="shrink-0">{children}</span>
      </span>
    </div>
  );
}
