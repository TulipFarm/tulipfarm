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
});
export type BrowserSessionState = z.infer<typeof browserSessionStateSchema>;

export const browserActionResultSchema = z.strictObject({
  state: browserSessionStateSchema,
  /** The page's accessibility snapshot, with refs for elements the agent can act on. Truncated when long. */
  snapshot: z.string(),
  truncated: z.boolean(),
  /** A JPEG screenshot of the viewport, base64-encoded. */
  screenshot: z.string(),
  /** What happened that the agent should know, such as a blocked address. */
  notice: z.string().optional(),
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
  'ref-not-found',
  'action-failed',
  'capacity',
  'invalid-request',
]);
export type BrowserHostErrorCode = z.infer<typeof browserHostErrorCodeSchema>;
export const browserHostErrorSchema = z.strictObject({ error: browserHostErrorCodeSchema, message: z.string() });
