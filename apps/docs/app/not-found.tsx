import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { Metadata } from "next";
import Link from "next/link";
import { baseOptions } from "@/lib/layout.shared";

export const metadata: Metadata = {
  title: "Page not found — tulipfarm docs",
};

const routes = [
  { label: "install tulipfarm", href: "/docs/self-hosting/install" },
  { label: "get started", href: "/docs/using-tulipfarm/build-your-first-thing" },
  { label: "concepts", href: "/docs/using-tulipfarm" },
  { label: "guides", href: "/docs/using-tulipfarm" },
  { label: "reference", href: "/docs/reference" },
  { label: "deploy", href: "/docs/self-hosting" },
];

export default function NotFound() {
  return (
    <HomeLayout {...baseOptions()}>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-24 sm:px-6">
        <p className="text-xs uppercase tracking-[0.2em] text-fd-muted-foreground">
          [404 · no such page]
        </p>
        <h1 className="mt-5 text-3xl font-bold tracking-tight sm:text-4xl">
          That page isn&apos;t here
          <span aria-hidden className="animate-cursor text-fd-primary">
            ▍
          </span>
        </h1>
        <p className="mt-5 max-w-xl text-sm leading-6 text-fd-muted-foreground sm:text-base">
          The link may be out of date, or the page moved. Search with{" "}
          <kbd className="rounded-sm border border-fd-border bg-fd-muted px-1.5 py-0.5 text-xs">
            ⌘K
          </kbd>
          , or pick up one of these instead.
        </p>
        <nav aria-label="Popular pages" className="mt-10 border-y border-fd-border">
          {routes.map((route) => (
            <Link
              key={route.href}
              href={route.href}
              className="group flex min-h-14 items-center justify-between gap-4 border-l-2 border-transparent px-3 text-sm transition-colors duration-150 hover:border-fd-primary hover:bg-fd-accent/60 sm:px-5"
            >
              <span>{route.label}</span>
              <span
                aria-hidden
                className="text-fd-primary transition-transform duration-150 group-hover:translate-x-1"
              >
                →
              </span>
            </Link>
          ))}
        </nav>
      </main>
    </HomeLayout>
  );
}
