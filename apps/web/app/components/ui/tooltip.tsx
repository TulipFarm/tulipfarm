import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "~/lib/utils";

const GAP = 8;

/**
 * Positions after measuring the label, then clamps it inside the viewport, so a trigger near an
 * edge cannot push half the text off-screen. Centring purely in CSS could not do this: a
 * `-translate-x-1/2` on a 36px rail icon puts most of a long label at a negative x.
 *
 * @param placement `"right"` for a vertical icon rail, where there is no room above.
 */
export function Tooltip({
  children,
  content,
  placement = "top",
}: {
  children: ReactNode;
  content: string;
  placement?: "top" | "right";
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!anchor || !tip) return;
    const { width, height } = tip.getBoundingClientRect();
    const maxLeft = Math.max(GAP, window.innerWidth - GAP - width);
    const maxTop = Math.max(GAP, window.innerHeight - GAP - height);

    let left =
      placement === "right" ? anchor.right + GAP : anchor.left + anchor.width / 2 - width / 2;
    let top =
      placement === "right"
        ? anchor.top + anchor.height / 2 - height / 2
        : anchor.top - GAP - height;

    // Flip to the opposite side before clamping, so a cramped edge does not cover the trigger.
    if (placement === "right" && left > maxLeft) left = anchor.left - GAP - width;
    if (placement === "top" && top < GAP) top = anchor.bottom + GAP;

    setPosition({
      left: Math.min(Math.max(GAP, left), maxLeft),
      top: Math.min(Math.max(GAP, top), maxTop),
    });
  }, [anchor, placement]);

  function show() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setAnchor(rect);
  }

  function hide() {
    setAnchor(null);
    setPosition(null);
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: observes its native interactive child so the tooltip can be portalled outside clipping containers.
    <span
      ref={triggerRef}
      className="inline-flex min-w-0"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
    >
      {children}
      {anchor
        ? createPortal(
            <span
              ref={tipRef}
              role="tooltip"
              className={cn(
                "pointer-events-none fixed z-[100] max-w-[min(16rem,calc(100vw-1rem))]",
                "rounded-md border border-border bg-popover px-2 py-1 text-xs",
                "text-popover-foreground",
                position ? "opacity-100" : "opacity-0"
              )}
              style={{ left: position?.left ?? 0, top: position?.top ?? 0 }}
            >
              {content}
            </span>,
            document.body
          )
        : null}
    </span>
  );
}
