import { cloneElement, isValidElement, type ReactElement, type ReactNode, useId } from "react";
import { cn } from "~/lib/utils";

/**
 * A labelled form control.
 *
 * The label sits above the control and help text is persistent rather than hidden behind a
 * tooltip, so a participant can read the constraint before committing to a value. The error
 * replaces nothing — it appears below and is announced.
 */
export function Field({
  label,
  help,
  error,
  required = false,
  htmlFor,
  className,
  children,
}: {
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  const generatedId = useId();
  const controlId = htmlFor ?? generatedId;
  const helpId = help ? `${controlId}-help` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;

  const control =
    isValidElement(children) && !htmlFor
      ? cloneElement(children as ReactElement<Record<string, unknown>>, {
          id: (children.props as Record<string, unknown>).id ?? controlId,
          "aria-describedby":
            (children.props as Record<string, unknown>)["aria-describedby"] ?? describedBy,
          "aria-invalid": error
            ? true
            : (children.props as Record<string, unknown>)["aria-invalid"],
        })
      : children;

  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={controlId} className="block text-sm font-medium text-foreground">
        {label}
        {required ? (
          <span className="ml-1 text-muted-foreground" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {control}
      {help ? (
        <p id={helpId} className="text-xs text-muted-foreground">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A read-only label/value pair for detail views.
 *
 * Render inside a `<dl>`. Labels stay sentence case — uppercase tracking on a normal label is not
 * part of the type scale.
 */
export function ReadonlyField({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-foreground">{children}</dd>
    </div>
  );
}
