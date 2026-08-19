import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/shared";
import { source } from "@/lib/source";

export const dynamic = "force-static";

/** Home plus every docs page. Docs outrank the marketing page, so they carry higher priority. */
export default function sitemap(): MetadataRoute.Sitemap {
  const pages = source.getPages().map((page) => ({
    url: new URL(page.url, SITE_URL).toString(),
    changeFrequency: "weekly" as const,
    priority: 0.8,
  }));

  return [
    {
      url: new URL("/", SITE_URL).toString(),
      changeFrequency: "monthly" as const,
      priority: 1,
    },
    ...pages,
  ];
}
