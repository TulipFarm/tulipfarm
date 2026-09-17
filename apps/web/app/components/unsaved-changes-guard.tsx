import { useBlocker } from "@remix-run/react";
import { useCallback, useEffect, useRef } from "react";
import { Button } from "~/components/ui/button";

export function useUnsavedChangesGuard(dirty: boolean) {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    const current = `${currentLocation.pathname}${currentLocation.search}${currentLocation.hash}`;
    const next = `${nextLocation.pathname}${nextLocation.search}${nextLocation.hash}`;
    return dirtyRef.current && current !== next;
  });

  const clear = useCallback(() => {
    dirtyRef.current = false;
  }, []);

  return {
    blocked: blocker.state === "blocked",
    clear,
    keepEditing: () => blocker.reset?.(),
    discard: () => {
      dirtyRef.current = false;
      blocker.proceed?.();
    },
  };
}

export function UnsavedChangesDialog({
  blocked,
  keepEditing,
  discard,
}: {
  blocked: boolean;
  keepEditing: () => void;
  discard: () => void;
}) {
  if (!blocked) return null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="unsaved-changes-title"
      className="flex flex-col gap-3 rounded-sm border border-border bg-card p-4"
    >
      <p id="unsaved-changes-title" className="text-sm font-medium text-foreground">
        Leave without saving?
      </p>
      <p className="text-sm text-muted-foreground">
        This page has changes that have not been saved. Leaving now discards them.
      </p>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" onClick={keepEditing}>
          Keep editing
        </Button>
        <Button type="button" variant="destructive" onClick={discard}>
          Discard changes
        </Button>
      </div>
    </div>
  );
}
