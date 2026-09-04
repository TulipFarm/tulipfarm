import { useNavigation } from "@remix-run/react";
import { useEffect, useState } from "react";

/**
 * A navigation in SPA mode has to fetch the destination's route module before its `clientLoader`
 * can even start, so a cold click can spend a second with nothing on screen changing. Without a
 * signal that reads as "working", the app looks like it ignored the click — which is what people
 * report as "the link does nothing", and why they reach for a full page reload.
 */
const APPEAR_AFTER_MS = 120;

export function GlobalPending() {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [visible, setVisible] = useState(false);

  // Held back briefly so a warm navigation — one whose modules are already cached, which is most of
  // them once `prefetch="intent"` has run — completes without flashing a bar at the reader.
  useEffect(() => {
    if (!busy) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), APPEAR_AFTER_MS);
    return () => clearTimeout(timer);
  }, [busy]);

  return (
    <div
      aria-hidden={!visible}
      className={`pointer-events-none fixed inset-x-0 top-0 z-[200] h-0.5 transition-opacity ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      <div className="tf-nav-progress h-full w-full bg-primary" />
      <span role="status" aria-live="polite" className="sr-only">
        {visible ? "Loading page" : ""}
      </span>
    </div>
  );
}
