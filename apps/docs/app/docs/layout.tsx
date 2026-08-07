import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export default function Layout({ children }: LayoutProps<"/docs">) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      {...baseOptions()}
      links={[
        { text: "home", url: "/" },
        { text: "install", url: "/docs/installation" },
      ]}
      sidebar={{
        footer: (
          <a
            href="/llms.txt"
            className="cursor-pointer px-2 py-1 text-xs text-fd-muted-foreground transition-colors duration-150 hover:text-fd-foreground"
          >
            llms.txt — these docs, for your agent
          </a>
        ),
      }}
    >
      {children}
    </DocsLayout>
  );
}
