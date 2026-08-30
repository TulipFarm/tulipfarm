import { type ReactNode, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function Tooltip({ children, content }: { children: ReactNode; content: string }) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  function show() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ left: rect.left + rect.width / 2, top: rect.top - 8 });
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: observes its native interactive child so the tooltip can be portalled outside clipping containers.
    <span
      ref={triggerRef}
      className="inline-flex min-w-0"
      onMouseEnter={show}
      onMouseLeave={() => setPosition(null)}
      onFocusCapture={show}
      onBlurCapture={() => setPosition(null)}
    >
      {children}
      {position
        ? createPortal(
            <span
              role="tooltip"
              className="pointer-events-none fixed z-[100] -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground"
              style={position}
            >
              {content}
            </span>,
            document.body
          )
        : null}
    </span>
  );
}
