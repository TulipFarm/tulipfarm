import { Eye, EyeOff } from "lucide-react";
import { type Ref, useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";

export interface PromptFieldProps {
  label: string;
  hint?: string;
  error?: string;
  type?: "text" | "email" | "password";
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  /** Mobile keeps a 44px target and 16px text so iOS does not zoom on focus. */
  controlClassName?: string;
  ref?: Ref<HTMLInputElement>;
}

/**
 * One question, one input — the unit the pre-login tulip flow advances by. Enter submits because
 * each question is its own `<form>`; this component owns only the field, not the form or the
 * Continue action, so the caller controls submit/back/skip.
 */
export function PromptField({
  label,
  hint,
  error,
  type = "text",
  value,
  onChange,
  autoComplete,
  controlClassName,
  ref,
}: PromptFieldProps) {
  const id = useId();
  const [reveal, setReveal] = useState(false);
  const isPassword = type === "password";
  const note = error ?? hint;

  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <div className="relative">
        <Input
          id={id}
          ref={ref}
          type={isPassword && reveal ? "text" : type}
          autoComplete={autoComplete}
          className={cn(controlClassName, isPassword && "pr-11")}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={note ? `${id}-note` : undefined}
          required
        />
        {isPassword ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-0.5 top-0.5 size-8"
            onClick={() => setReveal((v) => !v)}
            aria-label={reveal ? "Hide password" : "Show password"}
          >
            {reveal ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          </Button>
        ) : null}
      </div>
      {note ? (
        <span
          id={`${id}-note`}
          className={cn(
            "text-xs font-normal",
            error ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {note}
        </span>
      ) : null}
    </div>
  );
}
