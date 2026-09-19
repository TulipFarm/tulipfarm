import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { SITE_URL, siteDescription, siteHeadline, siteName } from "@/lib/site";
import "./global.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: `${siteName}: ${siteHeadline}`, template: "%s | TulipFarm" },
  description: siteDescription,
  openGraph: {
    type: "website",
    siteName,
    title: siteHeadline,
    description: siteDescription,
    url: SITE_URL,
    images: [{ url: "/opengraph-image.png", width: 1200, height: 630, alt: siteHeadline }],
  },
  twitter: {
    card: "summary_large_image",
    title: siteHeadline,
    description: siteDescription,
    images: ["/opengraph-image.png"],
  },
  icons: { icon: "/favicon.ico", apple: "/apple-touch-icon.png" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          rel="preload"
          href="/fonts/dm-sans.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body>
        <a href="#main-content" className="skip-link">
          Skip to content
        </a>
        <SiteHeader />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
