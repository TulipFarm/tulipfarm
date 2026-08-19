"use client";

import { Breadcrumb } from "fumadocs-ui/layouts/docs/page/slots/breadcrumb";
import { Footer } from "fumadocs-ui/layouts/docs/page/slots/footer";
import { TOC, TOCPopover, TOCProvider } from "fumadocs-ui/layouts/docs/page/slots/toc";
import type { ComponentProps } from "react";
import { twMerge } from "tailwind-merge";

type DocsPageProps = ComponentProps<"article"> & {
  full?: boolean;
  toc?: ComponentProps<typeof TOCProvider>["toc"];
};

export function DocsPage({ children, className, full = false, toc = [], ...props }: DocsPageProps) {
  return (
    <TOCProvider toc={toc}>
      {/* Upstream renders a progress ring with role="progressbar" inside the trigger, so its
          aria-valuenow leaks a decimal into the button's accessible name. */}
      {toc.length > 0 && <TOCPopover trigger={{ "aria-label": "On this page" }} />}
      <article
        id="nd-page"
        data-full={full}
        {...props}
        className={twMerge(
          "mx-auto flex w-full max-w-[900px] flex-col gap-4 px-4 py-6 [grid-area:main] md:px-6 md:pt-8 xl:px-8 xl:pt-14",
          full && "max-w-[1168px]",
          className
        )}
      >
        <Breadcrumb />
        {children}
        <Footer />
      </article>
      {!full && <TOC />}
    </TOCProvider>
  );
}

export function DocsBody({ children, className, ...props }: ComponentProps<"div">) {
  return (
    <div {...props} className={twMerge("prose flex-1", className)}>
      {children}
    </div>
  );
}

export function DocsDescription({ children, className, ...props }: ComponentProps<"p">) {
  if (children === undefined) return null;

  return (
    <p {...props} className={twMerge("mb-8 text-lg text-fd-muted-foreground", className)}>
      {children}
    </p>
  );
}

export function DocsTitle({ children, className, ...props }: ComponentProps<"h1">) {
  return (
    <h1 {...props} className={twMerge("text-[1.75em] font-semibold", className)}>
      {children}
    </h1>
  );
}
