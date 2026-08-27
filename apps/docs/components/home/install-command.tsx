"use client";

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { SITE_URL } from "@/lib/shared";

const platforms = {
  unix: {
    label: "linux / macos",
    command: `curl -fsSL ${SITE_URL}/install.sh | sudo bash`,
    tokens: [
      { value: "curl", className: "text-fd-primary" },
      { value: " -fsSL ", className: "text-fd-muted-foreground" },
      { value: `${SITE_URL}/install.sh`, className: "text-fd-foreground" },
      { value: " | ", className: "text-fd-primary" },
      { value: "sudo bash", className: "text-fd-foreground" },
    ],
  },
  windows: {
    label: "windows",
    command: `irm ${SITE_URL}/install.ps1 | iex`,
    tokens: [
      { value: "irm", className: "text-fd-primary" },
      { value: " ", className: "text-fd-muted-foreground" },
      { value: `${SITE_URL}/install.ps1`, className: "text-fd-foreground" },
      { value: " | ", className: "text-fd-primary" },
      { value: "iex", className: "text-fd-foreground" },
    ],
  },
} as const;

type Platform = keyof typeof platforms;
type CopyState = "idle" | "copied" | "failed";
const platformKeys = Object.keys(platforms) as Platform[];

/** One string for one event, so the visible hint and the announced hint cannot drift apart. */
const copyFailedMessage = "Copy failed. Select the command and copy it.";

export function InstallCommand() {
  const [platform, setPlatform] = useState<Platform>("unix");
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const selected = platforms[platform];

  function selectPlatform(nextPlatform: Platform) {
    setPlatform(nextPlatform);
    setCopyState("idle");
  }

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, currentPlatform: Platform) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

    event.preventDefault();
    const currentIndex = platformKeys.indexOf(currentPlatform);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? platformKeys.length - 1
          : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + platformKeys.length) %
            platformKeys.length;
    const nextPlatform = platformKeys[nextIndex];
    selectPlatform(nextPlatform);

    const tabs =
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs?.[nextIndex]?.focus();
  }

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(selected.command);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }

    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopyState("idle"), 2500);
  }

  useEffect(
    () => () => {
      clearTimeout(resetTimer.current);
    },
    []
  );

  const copyLabel = copyState === "copied" ? "copied" : copyState === "failed" ? "retry" : "copy";

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-lg border border-fd-border bg-fd-card">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-fd-border px-4">
        <p className="font-mono text-xs text-fd-muted-foreground">install</p>
        <div className="flex" aria-label="Choose operating system" role="tablist">
          {platformKeys.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              id={`install-tab-${key}`}
              aria-controls="install-command-panel"
              aria-selected={platform === key}
              tabIndex={platform === key ? 0 : -1}
              onClick={() => selectPlatform(key)}
              onKeyDown={(event) => navigateTabs(event, key)}
              className="min-h-11 cursor-pointer border-b-2 border-transparent px-3 text-xs text-fd-muted-foreground transition-colors duration-150 hover:text-fd-foreground aria-selected:border-fd-primary aria-selected:text-fd-foreground"
            >
              {platforms[key].label}
            </button>
          ))}
        </div>
      </div>
      <div
        id="install-command-panel"
        role="tabpanel"
        aria-labelledby={`install-tab-${platform}`}
        className="min-w-0 p-4 sm:p-5"
      >
        <p className="mb-3 text-xs text-fd-muted-foreground">
          {copyState === "failed" ? (
            <span className="text-fd-foreground">{copyFailedMessage}</span>
          ) : (
            <>
              $ <span className="text-fd-foreground">one command. zero config questions.</span>
            </>
          )}
        </p>
        <div className="relative min-w-0 border border-fd-border bg-fd-background">
          <pre className="min-h-13 whitespace-pre-wrap px-4 py-3.5 pr-18 text-xs leading-6 tracking-[-0.02em]">
            <code className="[overflow-wrap:anywhere]">
              {selected.tokens.map((token, index) => (
                <span key={`${platform}-${index}-${token.value}`} className={token.className}>
                  {token.value}
                </span>
              ))}
            </code>
          </pre>
          <button
            type="button"
            onClick={copyCommand}
            aria-label={`Copy ${selected.label} install command`}
            className="absolute inset-y-0 right-0 min-h-11 w-16 cursor-pointer border-l border-fd-border bg-fd-background/80 text-xs font-medium text-fd-muted-foreground transition-colors duration-150 hover:bg-fd-accent hover:text-fd-foreground focus-visible:bg-fd-accent focus-visible:text-fd-foreground active:bg-fd-muted"
          >
            {copyLabel}
          </button>
        </div>
        <p className="sr-only" aria-live="polite">
          {copyState === "copied"
            ? `${selected.label} install command copied to the clipboard.`
            : copyState === "failed"
              ? copyFailedMessage
              : ""}
        </p>
      </div>
    </div>
  );
}
