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
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
