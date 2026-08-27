import type { Metadata } from "next";
import { Provider } from "@/components/provider";
import { appName, SITE_URL, siteDescription } from "@/lib/shared";
import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/jetbrains-mono";
import "./global.css";

// metadataBase resolves the relative OG image URLs that generateMetadata emits into absolute
// ones. `alternates.canonical` is deliberately NOT set here — metadata is inherited, so a root
// canonical would point every page at the home page. Each route sets its own.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: appName,
  description: siteDescription,
  openGraph: {
    type: "website",
    siteName: appName,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
  },
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen font-sans">
        <a
          href="#nd-page"
          className="sr-only rounded-sm bg-tf-fill px-4 py-2 text-sm font-medium text-tf-fill-foreground focus-visible:not-sr-only focus-visible:absolute focus-visible:start-4 focus-visible:top-4 focus-visible:z-50"
        >
          Skip to content
        </a>
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
