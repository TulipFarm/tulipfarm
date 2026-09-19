import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { Metadata } from "next";
import { baseOptions } from "@/lib/layout.shared";
import { appName, SITE_URL } from "@/lib/shared";
import { source } from "@/lib/source";

export const metadata: Metadata = {
  title: { template: `%s | ${appName}`, default: appName },
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      {...baseOptions()}
      links={[
        { text: "Website", url: SITE_URL, external: true },
        { text: "install", url: "/self-hosting/install" },
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
