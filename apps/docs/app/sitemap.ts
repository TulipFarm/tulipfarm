import type { MetadataRoute } from "next";
import { DOCS_URL } from "@/lib/shared";
import { source } from "@/lib/source";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return source.getPages().map((page) => ({
    url: new URL(page.url, DOCS_URL).toString(),
    changeFrequency: "weekly" as const,
    priority: page.url === "/docs" ? 1 : 0.8,
  }));
}
