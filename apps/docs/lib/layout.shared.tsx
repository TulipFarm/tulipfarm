import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import Image from "next/image";
import { appName, docsRoute, gitConfig, SITE_URL } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      url: docsRoute,
      title: (
        <>
          <Image src="/logo-128.png" alt="" width={24} height={24} className="size-6 rounded-sm" />
          {appName}
        </>
      ),
    },
    links: [{ text: "Website", url: SITE_URL, external: true }],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
