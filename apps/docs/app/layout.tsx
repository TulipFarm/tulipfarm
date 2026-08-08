import type { Metadata } from "next";
import { Provider } from "@/components/provider";
import { SITE_URL } from "@/lib/shared";
import "@fontsource-variable/jetbrains-mono";
import "./global.css";

// Resolves the relative OG image URLs that generateMetadata emits into absolute ones.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen font-sans">
        <a
          href="#nd-page"
          className="sr-only rounded-sm bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground focus-visible:not-sr-only focus-visible:absolute focus-visible:start-4 focus-visible:top-4 focus-visible:z-50"
        >
          Skip to content
        </a>
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
