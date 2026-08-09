import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { copyText } from "~/lib/clipboard";
import { cn } from "~/lib/utils";

/*
 * A value the operator has to move somewhere else by hand — a webhook URL to paste into a
 * provider's settings, an invite link to send.
 *
 * Confirmation is the point. `copyText` falls back to `execCommand` on insecure origins and can
 * still fail outright, so a button that looks identical whether or not the copy landed leaves the
 * operator pasting stale clipboard contents into a provider's form and wondering why setup broke.
 * The label reverts on a timer so a second copy is visibly acknowledged too.
 */

const REVERT_MS = 2000;

export function CopyField({
  value,
  label,
  className,
}: {
  value: string;
  /** Accessible name for the button, when several copyable values share a screen. */
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), REVERT_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <code className="min-w-0 flex-1 truncate rounded-sm border border-border bg-muted px-2 py-1 font-mono text-xs text-foreground">
        {value}
      </code>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        aria-label={label ? `Copy ${label}` : undefined}
        onClick={async () => setCopied(await copyText(value))}
      >
        {copied ? (
          <Check className="size-3" aria-hidden />
        ) : (
          <Copy className="size-3" aria-hidden />
        )}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
