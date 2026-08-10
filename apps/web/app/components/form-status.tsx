import { AlertCircle, CheckCircle2 } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * The result of a save, stated in one place.
 *
 * Errors are the API's own message, unprefixed — the old pages rendered `error: {message}`, which
 * says "error" twice next to a red icon. Success copy is confident, not celebratory.
 */
export function FormStatus({
  tone,
  children,
  className,
}: {
  tone: "error" | "success";
  children: ReactNode;
  className?: string;
}) {
  const isError = tone === "error";
  const Icon = isError ? AlertCircle : CheckCircle2;

  return (
    <p
      role={isError ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
        isError
          ? "border-destructive/40 bg-destructive/5 text-destructive"
          : "border-status-success/40 bg-status-success/5 text-status-success",
        className
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
