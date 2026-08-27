"use client";

import { buttonVariants } from "fumadocs-ui/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "fumadocs-ui/components/ui/popover";
import {
  Check,
  ChevronDown,
  CodeXml,
  Copy,
  ExternalLink,
  GitFork,
  MessageSquare,
  Sparkles,
  Text,
} from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type PageActionsProps = {
  githubUrl: string;
  markdownUrl: string;
};

type CopyState = "idle" | "copied" | "failed";

/** One string for one event, so the visible hint and the announced hint cannot drift apart. */
const copyFailedMessage = "Copy failed. Use Open > View as Markdown, then copy the page.";

export function PageActions({ githubUrl, markdownUrl }: PageActionsProps) {
  const pathname = usePathname();
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [isCopying, setIsCopying] = useState(false);
  const [pageUrl, setPageUrl] = useState(pathname);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setPageUrl(new URL(pathname, window.location.origin).toString());
  }, [pathname]);

  useEffect(
    () => () => {
      clearTimeout(resetTimer.current);
    },
    []
  );

  const question = `Read ${pageUrl}, I want to ask questions about it.`;
  const links = [
    {
      title: "Open in GitHub",
      href: githubUrl,
      icon: GitFork,
    },
    {
      title: "View as Markdown",
      href: markdownUrl,
      icon: Text,
    },
    {
      title: "Open in ChatGPT",
      href: `https://chatgpt.com/?${new URLSearchParams({
        prompt: question,
        hints: "search",
      })}`,
      icon: MessageSquare,
    },
    {
      title: "Open in Claude",
      href: `https://claude.ai/new?${new URLSearchParams({ q: question })}`,
      icon: Sparkles,
    },
    {
      title: "Open in Cursor",
      href: `https://cursor.com/link/prompt?${new URLSearchParams({ text: question })}`,
      icon: CodeXml,
    },
  ];

  async function copyMarkdown() {
    setIsCopying(true);
    clearTimeout(resetTimer.current);

    try {
      const response = await fetch(markdownUrl);
      if (!response.ok) throw new Error(`Markdown request failed: ${response.status}`);

      await navigator.clipboard.writeText(await response.text());
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    } finally {
      setIsCopying(false);
      resetTimer.current = setTimeout(() => setCopyState("idle"), 4000);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-b pb-6">
      <div className="flex flex-row items-center gap-2">
        <button
          type="button"
          disabled={isCopying}
          onClick={copyMarkdown}
          className={buttonVariants({
            color: "secondary",
            size: "sm",
            className: "cursor-pointer gap-2 [&_svg]:size-3.5 [&_svg]:text-fd-muted-foreground",
          })}
        >
          {copyState === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
          Copy Markdown
        </button>

        <Popover>
          <PopoverTrigger
            type="button"
            className={buttonVariants({
              color: "secondary",
              size: "sm",
              className:
                "cursor-pointer gap-2 data-[state=open]:bg-fd-accent data-[state=open]:text-fd-accent-foreground",
            })}
          >
            Open
            <ChevronDown className="size-3.5 text-fd-muted-foreground" aria-hidden />
          </PopoverTrigger>
          <PopoverContent className="flex flex-col" align="start">
            {links.map(({ title, href, icon: Icon }) => (
              <a
                key={href}
                href={href}
                rel="noreferrer noopener"
                target="_blank"
                className="inline-flex cursor-pointer items-center gap-2 rounded-lg p-2 text-sm hover:bg-fd-accent hover:text-fd-accent-foreground [&_svg]:size-4"
              >
                <Icon aria-hidden />
                {title}
                <span className="sr-only">(opens in a new tab)</span>
                <ExternalLink className="ms-auto size-3.5 text-fd-muted-foreground" aria-hidden />
              </a>
            ))}
          </PopoverContent>
        </Popover>
      </div>

      {copyState === "failed" && (
        <p className="text-xs text-fd-muted-foreground">{copyFailedMessage}</p>
      )}
      <p className="sr-only" aria-live="polite">
        {copyState === "copied"
          ? "Page Markdown copied to the clipboard."
          : copyState === "failed"
            ? copyFailedMessage
            : ""}
      </p>
    </div>
  );
}
