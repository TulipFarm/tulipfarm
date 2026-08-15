import { type MetaFunction, redirect, useNavigate } from "@remix-run/react";
import { AlertCircle, ArrowLeft, Loader2 } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { PromptField } from "~/components/onboarding/prompt-field";
import { TulipGrowth, type TulipStage } from "~/components/onboarding/tulip-growth";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import { completeSetup, getSetupStatus, setupAdmin } from "~/lib/setup";
import { cn } from "~/lib/utils";

export const meta: MetaFunction = () => [{ title: "Setup · tulipfarm" }];

// Redirect to / if setup is already complete (both headless and wizard paths).
export async function clientLoader() {
  const { needsSetup } = await getSetupStatus();
  if (!needsSetup) throw redirect("/");
  return null;
}

// Mobile keeps a 44px target and 16px text (below 16px iOS zooms the page on focus); desktop
// drops to the 36px control height the rest of the app uses.
const controlClass = "h-11 text-base sm:h-9 sm:text-sm";

type Question = 0 | 1 | 2;

const QUESTIONS: readonly {
  label: string;
  hint?: string;
  type: "text" | "email" | "password";
  autoComplete: string;
}[] = [
  { label: "What should we call you?", type: "text", autoComplete: "name" },
  {
    label: "Email",
    hint: "You will sign in with this address.",
    type: "email",
    autoComplete: "username",
  },
  {
    label: "Password",
    hint: "At least 8 characters.",
    type: "password",
    autoComplete: "new-password",
  },
];

function ErrorAlert({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{message}</span>
    </p>
  );
}

export default function SetupRoute() {
  const navigate = useNavigate();
  const [question, setQuestion] = useState<Question>(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Stage mirrors how many of the three answers are already committed — the tulip's growth is the
  // question index itself while an answer is being typed, and only reaches 3 once setup finishes.
  const stage: TulipStage = busy ? 3 : question;

  const values = [name, email, password];
  const setValue = (v: string) => {
    if (question === 0) setName(v);
    else if (question === 1) setEmail(v);
    else setPassword(v);
  };

  const goTo = (next: Question) => {
    setQuestion(next);
    setError(null);
    // The whole question swaps, which would otherwise drop focus to <body>.
    headingRef.current?.focus();
  };

  const back = () => goTo(Math.max(0, question - 1) as Question);

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      await setupAdmin(name.trim(), email.trim(), password);
      await completeSetup();
      navigate("/", { replace: true });
    } catch (err) {
      setBusy(false);
      const message =
        err instanceof ApiError ? err.message : "Setup failed — is the API reachable?";
      // A 422 names the offending field — rewind to the question that owns it.
      const owner =
        err instanceof ApiError
          ? err.path === "email"
            ? 1
            : err.path === "password"
              ? 2
              : err.path === "name"
                ? 0
                : null
          : null;
      if (owner !== null && owner !== question) {
        setQuestion(owner as Question);
      }
      setError(message);
      headingRef.current?.focus();
      inputRef.current?.focus();
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (question < 2) {
      goTo((question + 1) as Question);
    } else {
      void finish();
    }
  }

  const current = QUESTIONS[question];
  const disabled = question === 2 ? password.length < 8 : values[question]?.trim().length === 0;

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-10 px-6 py-12">
      <TulipGrowth stage={stage} />
      <p role="status" className="sr-only">
        {Math.min(question, 3)} of 3 answered
      </p>

      <div className="flex w-full max-w-sm flex-col gap-6">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-center text-xl font-semibold text-foreground outline-none"
        >
          Let's get your account set up
        </h1>

        {error && <ErrorAlert message={error} />}

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <PromptField
            ref={inputRef}
            label={current.label}
            hint={current.hint}
            type={current.type}
            autoComplete={current.autoComplete}
            controlClassName={controlClass}
            value={values[question] ?? ""}
            onChange={setValue}
          />
          <div className={cn("flex gap-2", question === 0 && "justify-end")}>
            {question > 0 ? (
              <Button
                type="button"
                variant="outline"
                className="h-11 px-4 active:translate-y-px sm:h-10"
                onClick={back}
                disabled={busy}
              >
                <ArrowLeft aria-hidden />
                Back
              </Button>
            ) : null}
            <Button
              type="submit"
              className="h-11 flex-1 active:translate-y-px sm:h-10"
              disabled={busy || disabled}
            >
              {busy ? (
                <>
                  <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" />
                  Creating account…
                </>
              ) : question === 2 ? (
                "Finish"
              ) : (
                "Continue"
              )}
            </Button>
          </div>
        </form>
      </div>
    </main>
  );
}
