import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { Metadata } from "next";
import { baseOptions } from "@/lib/layout.shared";
import { appName } from "@/lib/shared";
import { source } from "@/lib/source";

// Scoped to /docs so the marketing page, which sets its own full title, is not double-suffixed.
export const metadata: Metadata = {
  title: { template: `%s | ${appName}`, default: appName },
};

export default function Layout({ children }: LayoutProps<"/docs">) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      {...baseOptions()}
      links={[
        { text: "home", url: "/" },
        { text: "install", url: "/docs/self-hosting/install" },
      ]}
      sidebar={{
        footer: (
          <a
            href="/llms.txt"
            className="cursor-pointer px-2 py-1 text-xs text-fd-muted-foreground transition-colors hover:text-fd-foreground"
          >
            llms.txt, these docs for your agent
          </a>
        ),
      }}
    >
      {children}
    </DocsLayout>
  );
}
