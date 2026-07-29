"use client";

import { buttonVariants } from "fumadocs-ui/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "fumadocs-ui/components/ui/popover";
import { Bot, Check, ChevronDown, CodeXml, Copy, ExternalLink, GitFork, Text } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

type PageActionsProps = {
  githubUrl: string;
  markdownUrl: string;
};

export function PageActions({ githubUrl, markdownUrl }: PageActionsProps) {
  const pathname = usePathname();
  const [copied, setCopied] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [pageUrl, setPageUrl] = useState(pathname);

  useEffect(() => {
    setPageUrl(new URL(pathname, window.location.origin).toString());
  }, [pathname]);

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
      icon: Bot,
    },
    {
      title: "Open in Claude",
      href: `https://claude.ai/new?${new URLSearchParams({ q: question })}`,
      icon: Bot,
    },
    {
      title: "Open in Cursor",
      href: `https://cursor.com/link/prompt?${new URLSearchParams({ text: question })}`,
      icon: CodeXml,
    },
  ];

  async function copyMarkdown() {
    setIsCopying(true);

    try {
      const response = await fetch(markdownUrl);
      if (!response.ok) return;

      await navigator.clipboard.writeText(await response.text());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } finally {
      setIsCopying(false);
    }
  }

  return (
    <div className="flex flex-row items-center gap-2 border-b pb-6">
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
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
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
              <ExternalLink className="ms-auto size-3.5 text-fd-muted-foreground" aria-hidden />
            </a>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}
