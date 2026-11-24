import { z } from 'zod';

/** An element reference from the latest snapshot, such as `e12`. */
export const browserRefSchema = z
  .string()
  .regex(/^(?:f\d+)?e\d+$/, 'Use a ref from the latest snapshot, such as e12')
  .max(32);

export const browserUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .refine(value => !new URL(value).username && !new URL(value).password, 'URLs must not contain credentials');

export const browserActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('navigate'), url: browserUrlSchema }),
  z.strictObject({ action: z.literal('snapshot') }),
  z.strictObject({ action: z.literal('click'), ref: browserRefSchema }),
  z.strictObject({
    action: z.literal('type'),
    ref: browserRefSchema,
    text: z.string().max(4000),
    submit: z.boolean().default(false),
  }),
  z.strictObject({ action: z.literal('press'), key: z.string().min(1).max(64) }),
  z.strictObject({
    action: z.literal('select'),
    ref: browserRefSchema,
    values: z.array(z.string().max(500)).min(1).max(20),
  }),
  z.strictObject({ action: z.literal('scroll'), direction: z.enum(['up', 'down']) }),
  z.strictObject({ action: z.literal('back') }),
  z.strictObject({ action: z.literal('wait'), seconds: z.number().min(0.5).max(10) }),
]);
export type BrowserAction = z.infer<typeof browserActionSchema>;

/** A field of a secret to type, and the sign-in form field it goes in. */
export const browserSecretFieldSchema = z.strictObject({
  ref: browserRefSchema,
  kind: z.enum(['username', 'password']),
  value: z.string().min(1).max(4096),
});

/**
 * Types a secret into a sign-in form. The browser host types it only into a page and frame on one of `hosts`, the
 * secret's host destinations, and keeps it out of everything it returns.
 */
export const browserTypeSecretSchema = z
  .strictObject({
    hosts: z.array(z.string().min(1).max(253)).min(1).max(10),
    fields: z.array(browserSecretFieldSchema).min(1).max(2),
    submit: browserRefSchema.optional(),
  })
  .refine(
    input => new Set(input.fields.map(field => field.kind)).size === input.fields.length,
    'Type at most one username and one password',
  )
  .refine(input => input.fields.some(field => field.kind === 'password'), 'A sign-in needs a password field')
  .refine(input => new Set(input.fields.map(field => field.ref)).size === input.fields.length, 'Use a field once');
export type BrowserTypeSecret = z.infer<typeof browserTypeSecretSchema>;

/** Who drives the browser: the agent, or a member who took over. */
export const browserControllerSchema = z.enum(['agent', 'person']);
export type BrowserController = z.infer<typeof browserControllerSchema>;

export const browserSessionIdSchema = z.uuid();

const hostPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** A website, named by its host without a leading `www.`, such as `amazon.com` or `accounts.google.com`. */
export const browserSiteSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform(value => value.replace(/^www\./, ''))
  .pipe(z.string().regex(hostPattern, 'Use a site such as amazon.com'));

/** The site of a page, or null for pages that are not on a named public host. */
export function browserSiteOf(url: string): string | null {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    const parsed = browserSiteSchema.safeParse(hostname);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The sites an agent's browser may open, when its manager limits it. Each one includes its subdomains. */
export const browserAllowedSitesSchema = z.array(browserSiteSchema).min(1).max(50);

/** Whether a page's host is one of the allowed sites or a subdomain of one. */
export function siteAllows(sites: readonly string[], hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return sites.some(site => host === site || host.endsWith(`.${site}`));
}

export const browserOpenSchema = z.strictObject({
  sessionId: z.uuid(),
  /** The workspace the session belongs to, so the host limits how many it runs at once. Absent, no workspace limit. */
  workspaceId: z.uuid().optional(),
  /** Limits the session's pages to these sites. Applies when the session opens; absent, any public site. */
  allowedSites: browserAllowedSitesSchema.optional(),
});
export type BrowserOpen = z.infer<typeof browserOpenSchema>;

/** Whether a cookie or storage domain belongs to a site: the site itself, a subdomain, or a parent it shares cookies with. */
export function siteIncludes(site: string, domain: string): boolean {
  const host = domain.toLowerCase().replace(/^\./, '');
  return host === site || host.endsWith(`.${site}`) || (site.endsWith(`.${host}`) && host.includes('.'));
}

export const browserCookieSchema = z.object({
  name: z.string().max(4096),
  value: z.string().max(16_384),
  domain: z.string().min(1).max(253),
  path: z.string().max(2048),
  /** Seconds since the epoch, or -1 for a cookie that ends with the session. */
  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(['Strict', 'Lax', 'None']),
});

/** The signed-in state of one site in a browser session: its cookies and each origin's local storage. */
export const browserSiteStateSchema = z.object({
  cookies: z.array(browserCookieSchema).max(1000),
  origins: z
    .array(
      z.object({
        origin: z.string().max(2048),
        localStorage: z.array(z.object({ name: z.string().max(4096), value: z.string() })).max(2000),
      }),
    )
    .max(100),
});
export type BrowserSiteState = z.infer<typeof browserSiteStateSchema>;

/** A browser login loaded into a session. `signedOut` is set when the agent asked a person to sign in to its site again. */
export const browserLoadedLoginSchema = z.strictObject({
  id: z.uuid(),
  site: z.string(),
  signedOut: z.boolean(),
});
export type BrowserLoadedLogin = z.infer<typeof browserLoadedLoginSchema>;

export const browserLoadLoginSchema = z.strictObject({
  id: z.uuid(),
  site: browserSiteSchema,
  state: browserSiteStateSchema,
});
export type BrowserLoadLogin = z.infer<typeof browserLoadLoginSchema>;

export const browserSiteStateRequestSchema = z.strictObject({ site: browserSiteSchema });

export const browserSessionStateSchema = z.strictObject({
  sessionId: browserSessionIdSchema,
  url: z.string(),
  title: z.string(),
  controller: browserControllerSchema,
  /** Why the agent handed the session to a person, while it waits for one. */
  needsPerson: z.string().nullable(),
  /** The member who took over, while one has control. */
  controlledBy: z.string().nullable(),
  /** The site the agent asked a person to sign in to, while it waits for one. */
  signIn: z.string().nullable(),
  /** The browser logins loaded into the session. */
  logins: z.array(browserLoadedLoginSchema),
  /** When the host opened this session. A session that closes and opens again gets a new time. */
  openedAt: z.string().optional(),
  /** When the host closes the session if nothing uses it before then. */
  closesAt: z.string().optional(),
});
export type BrowserSessionState = z.infer<typeof browserSessionStateSchema>;

/** The largest file a session downloads or uploads, the same as the largest file in Files. */
export const browserFileBytes = 100 * 1024 * 1024;

/** A file the page downloaded, held by the browser host until it is saved to Files. */
export const browserDownloadSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(255),
  size: z.int().min(0),
});
export type BrowserDownload = z.infer<typeof browserDownloadSchema>;

/** Where to put a file the agent uploads: the file input or upload control with `ref`. The bytes are the body. */
export const browserUploadSchema = z.strictObject({
  ref: browserRefSchema,
  name: z.string().trim().min(1).max(255),
  mediaType: z
    .string()
    .max(255)
    .regex(/^[\w.+-]+\/[\w.+-]+$/, 'Use a media type such as application/pdf'),
});
export type BrowserUpload = z.infer<typeof browserUploadSchema>;

export const browserActionResultSchema = z.strictObject({
  state: browserSessionStateSchema,
  /** The page's accessibility snapshot, with refs for elements the agent can act on. Truncated when long. */
  snapshot: z.string(),
  truncated: z.boolean(),
  /** A JPEG screenshot of the viewport, base64-encoded. Left out when the page could show a typed secret. */
  screenshot: z.string().optional(),
  /** What happened that the agent should know, such as a blocked address. */
  notice: z.string().optional(),
  /** Finished downloads the host holds, to save to Files. */
  downloads: z.array(browserDownloadSchema).optional(),
});
export type BrowserActionResult = z.infer<typeof browserActionResultSchema>;

export const browserControlSchema = z.discriminatedUnion('controller', [
  z.strictObject({ controller: z.literal('agent') }),
  z.strictObject({ controller: z.literal('person'), memberId: z.string().min(1).max(200) }),
]);
export type BrowserControl = z.infer<typeof browserControlSchema>;

export const browserNeedsPersonSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
  signIn: browserSiteSchema.optional(),
});
export type BrowserNeedsPerson = z.infer<typeof browserNeedsPersonSchema>;

const coordinate = z.number().min(0).max(4096);
const modifiers = z.int().min(0).max(15).default(0);

/** One input event from a member who took over, in viewport CSS pixels. */
export const browserInputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('mouse'),
    event: z.enum(['mousePressed', 'mouseReleased', 'mouseMoved']),
    x: coordinate,
    y: coordinate,
    button: z.enum(['none', 'left', 'middle', 'right']).default('left'),
    clickCount: z.int().min(0).max(3).default(1),
    modifiers,
  }),
  z.strictObject({
    type: z.literal('wheel'),
    x: coordinate,
    y: coordinate,
    deltaX: z.number().min(-5000).max(5000),
    deltaY: z.number().min(-5000).max(5000),
  }),
  z.strictObject({
    type: z.literal('key'),
    event: z.enum(['keyDown', 'keyUp']),
    key: z.string().min(1).max(64),
    code: z.string().max(64).default(''),
    text: z.string().max(8).optional(),
    modifiers,
  }),
  z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(2000) }),
]);
export type BrowserInput = z.infer<typeof browserInputSchema>;

/** One input, or several sent together in order so fast typing doesn't need a request per key. */
export const browserInputsSchema = z.union([browserInputSchema, z.array(browserInputSchema).min(1).max(50)]);
export type BrowserInputs = z.infer<typeof browserInputsSchema>;

export const browserViewport = { width: 1280, height: 800 } as const;

export const browserFrameSchema = z.strictObject({
  /** A JPEG frame, base64-encoded. */
  data: z.string(),
  width: z.number(),
  height: z.number(),
});
export type BrowserFrame = z.infer<typeof browserFrameSchema>;

export const browserHostErrorCodeSchema = z.enum([
  'session-not-found',
  'person-in-control',
  'agent-in-control',
  'address-denied',
  'destination-denied',
  'field-refused',
  'ref-not-found',
  'download-not-found',
  'action-failed',
  'capacity',
  'browser-busy',
  'invalid-request',
]);
export type BrowserHostErrorCode = z.infer<typeof browserHostErrorCodeSchema>;
export const browserHostErrorSchema = z.strictObject({
  error: browserHostErrorCodeSchema,
  message: z.string(),
  /** For `browser-busy`: where the request was in its workspace's queue when it gave up waiting. */
  position: z.int().positive().optional(),
});
