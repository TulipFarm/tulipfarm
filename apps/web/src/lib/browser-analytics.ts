// Vendor-neutral browser privacy rules: the consent cookie and URL scrubbing. An analytics
// extension (the `analytics` web override) uses these; TulipFarm itself sends nothing.
export const consentKey = 'tulipfarm.analytics-consent.v2';
const legacyKey = 'tulipfarm.analytics-consent.v1';
export const preferencesEvent = 'tulipfarm:analytics-preferences';
export const consentEvent = 'tulipfarm:analytics-consent';
export type Consent = 'accepted' | 'rejected' | null;
export type Site = 'marketing' | 'docs' | 'app';
export type SiteOrigins = Partial<Record<Site, string | undefined>>;

function origin(value: string | undefined) {
  try {
    return value ? new URL(value).origin : undefined;
  } catch {
    return undefined;
  }
}

/** The app is wherever it is served; the website and docs origins come from the build. */
export function siteOrigins(): SiteOrigins {
  return {
    app: typeof window !== 'undefined' ? origin(window.location?.href) : undefined,
    marketing: origin(import.meta.env.VITE_WEBSITE_URL),
    docs: origin(import.meta.env.VITE_DOCS_URL),
  };
}

// The consent cookie is shared with the website when the app is served from one of its subdomains.
function consentCookieDomain(origins: SiteOrigins) {
  if (!origins.marketing) return '';
  const site = new URL(origins.marketing).hostname;
  const current = window.location.hostname;
  return current === site || current.endsWith(`.${site}`) ? `; Domain=${site}` : '';
}
const campaignKeys = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']);
const privatePaths = new Set([
  'login',
  'register',
  'signup',
  'logout',
  'verify-email',
  'complete-profile',
  'create-workspace',
  'onboarding',
  'auth',
  'callback',
  'forgot-password',
  'reset-password',
  'invite',
  'github',
  'atlassian',
  'google-workspace',
  'slack',
]);
const routeSegments = new Set([
  'chat',
  'inbox',
  'help',
  'agents',
  'agent-tasks',
  'projects',
  'files',
  'skills',
  'workflows',
  'settings',
  'models',
  'account',
  'usage',
  'tables',
  'members',
  'teams',
  'grants',
  'integrations',
  'new',
  'edit',
  'import',
]);

export function privacySignal() {
  return (
    typeof navigator !== 'undefined' &&
    (navigator.doNotTrack === '1' ||
      (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true)
  );
}

function storedConsent(): Consent {
  if (typeof document === 'undefined') return null;
  const value = document.cookie
    .split('; ')
    .find(part => part.startsWith(`${consentKey}=`))
    ?.split('=')[1];
  return value === 'accepted' || value === 'rejected' ? value : null;
}

export function readConsent(): Consent {
  return privacySignal() ? 'rejected' : storedConsent();
}

export function writeConsent(accepted: boolean) {
  const value = accepted && !privacySignal() ? 'accepted' : 'rejected';
  const domain = consentCookieDomain(siteOrigins());
  // biome-ignore lint/suspicious/noDocumentCookie: synchronous consent checks must work without Cookie Store support.
  document.cookie = `${consentKey}=${value}; Path=/; Max-Age=15552000; SameSite=Lax${domain}${window.location.protocol === 'https:' ? '; Secure' : ''}`;
  try {
    localStorage.removeItem(legacyKey);
    localStorage.setItem(consentKey, value);
  } catch {
    /* Cookies remain the authority when localStorage is unavailable. */
  }
  window.dispatchEvent(new Event(consentEvent));
}

export function migrateConsent() {
  if (privacySignal()) {
    writeConsent(false);
    return;
  }
  try {
    if (!storedConsent() && localStorage.getItem(legacyKey) === 'accepted') writeConsent(true);
    localStorage.removeItem(legacyKey);
  } catch {
    /* A missing preference never implies consent. */
  }
}

export function privateEntry() {
  return privatePaths.has(window.location.pathname.split('/').filter(Boolean)[0] || '');
}

export function safeUrl(value: string, site: Site = 'marketing', origins: SiteOrigins = siteOrigins()): string {
  try {
    const url = new URL(value, origins[site] ?? origins.app);
    url.username = '';
    url.password = '';
    url.hash = '';
    const params = new URLSearchParams();
    if (site !== 'app') {
      for (const [key, item] of url.searchParams) {
        if (campaignKeys.has(key) && /^[a-z0-9_-]{1,80}$/i.test(item)) params.set(key, item);
      }
    }
    url.search = params.toString();
    if (
      site === 'app' &&
      url.origin === origins.app &&
      !privatePaths.has(url.pathname.split('/')[1] || '') &&
      !/^\/assets\/[\w.-]+\.(js|css)$/.test(url.pathname)
    ) {
      // Workspace slugs and record identifiers are private, even in a URL.
      const parts = url.pathname.split('/').filter(Boolean);
      url.pathname =
        '/workspace' +
        parts
          .slice(1)
          .map(part => `/${routeSegments.has(part) ? part : ':id'}`)
          .join('');
    }
    return url.toString();
  } catch {
    return '';
  }
}

export function scrubUrls(value: unknown, site: Site, origins: SiteOrigins = siteOrigins()): unknown {
  if (Array.isArray(value)) return value.map(item => scrubUrls(item, site, origins));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        /^https?:\/\//.test(key) ? safeUrl(key, site, origins) : key,
        scrubUrls(item, site, origins),
      ]),
    );
  }
  return typeof value === 'string' && /^https?:\/\//.test(value) ? safeUrl(value, site, origins) : value;
}
