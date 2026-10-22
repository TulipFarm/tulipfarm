interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** Public website origin, e.g. https://tulipfarm.ai. Optional; enables the privacy link and a shared consent cookie. */
  readonly VITE_WEBSITE_URL?: string;
  /** Public documentation origin. Optional. */
  readonly VITE_DOCS_URL?: string;
  /** Origin serving agent avatar artwork at `/avatar/<object>/<color>.svg`. Optional; unset shows initials. */
  readonly VITE_AGENT_AVATAR_URL?: string;
  /** Support email shown on the Help page. Optional; unset hides the contact section. */
  readonly VITE_SUPPORT_EMAIL?: string;
  /** Comma-separated web extension module specifiers, read at build time. */
  readonly VITE_TULIPFARM_WEB_EXTENSIONS?: string;
}

declare module 'virtual:tulipfarm-web-extensions' {
  import type { WebExtension } from '@tulipfarm/extensions/web';
  import type { WebSlots } from '@/extensions';
  const extensions: readonly WebExtension<WebSlots>[];
  export default extensions;
}
