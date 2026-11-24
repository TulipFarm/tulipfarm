import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page, type Request } from 'playwright-core';
import {
  browserViewport,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserControl,
  type BrowserFrame,
  type BrowserHostErrorCode,
  type BrowserInput,
  type BrowserInputs,
  type BrowserLoadedLogin,
  type BrowserLoadLogin,
  type BrowserNeedsPerson,
  type BrowserSessionState,
  type BrowserSiteState,
  type BrowserTypeSecret,
  browserSiteOf,
  siteAllows,
  siteIncludes,
} from '@tulipfarm/browser/contracts';
import { publicAddress } from '@tulipfarm/workspace-mcp-transport';
import { startEgressProxy } from './egress.ts';

export class HostError extends Error {
  readonly code: BrowserHostErrorCode;
  readonly status: number;
  constructor(code: BrowserHostErrorCode, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type HostOptions = {
  executablePath?: string | undefined;
  sandbox?: boolean;
  maxSessions: number;
  /** A session nobody used for this long is closed, unless it waits for a person. */
  idleMs: number;
  /** How long a session that needs a person waits for one. */
  holdMs: number;
  /** Lets pages reach private and loopback addresses. Only for tests against a local site. */
  allowPrivateNetworks?: boolean;
  /** Which resolved addresses pages may reach. Defaults to public addresses only; tests narrow it. */
  allowAddress?: (address: string) => boolean;
  /** Most characters of snapshot returned to the agent. */
  snapshotChars?: number;
  now?: () => number;
};

export type SessionEvent = { type: 'frame'; frame: BrowserFrame } | { type: 'state'; state: BrowserSessionState };
type Listener = (event: SessionEvent) => void;

/** Escapes text as Playwright quotes it in a snapshot's YAML, without the surrounding quotes. */
function yamlEscape(text: string): string {
  const named: Record<string, string> = {
    '\\': '\\\\',
    '"': '\\"',
    '\b': '\\b',
    '\f': '\\f',
    '\n': '\\n',
    '\r': '\\r',
    '\t': '\\t',
  };
  return [...text]
    .map(c => {
      const code = c.charCodeAt(0);
      const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
      return named[c] ?? (control ? `\\x${code.toString(16).padStart(2, '0')}` : c);
    })
    .join('');
}

class Session {
  readonly id: string;
  readonly context: BrowserContext;
  page: Page;
  controller: 'agent' | 'person' = 'agent';
  controlledBy: string | null = null;
  needsPerson: string | null = null;
  signIn: string | null = null;
  readonly logins = new Map<string, BrowserLoadedLogin>();
  /** Counts logins loaded, so each load's storage replaces the previous one's once. */
  loads = 0;
  lastUsed: number;
  notice: string | undefined;
  title = '';
  /** Every form of the secrets typed in this session, longest first, to keep out of what the host returns. */
  private typed: string[] = [];
  private cdp: CDPSession | undefined;
  private screencasting = false;
  private lastFrame: BrowserFrame | undefined;
  private readonly listeners = new Set<Listener>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(id: string, context: BrowserContext, page: Page, now: number) {
    this.id = id;
    this.context = context;
    this.page = page;
    this.lastUsed = now;
  }

  /** Agent actions, a person's input and control changes run one at a time, so a takeover waits for the agent's action. */
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Whether a secret was typed in this session; from then on the agent gets no screenshots. */
  get hasTypedSecret() {
    return this.typed.length > 0;
  }

  /**
   * Remembers a typed secret so `redact` removes it. A page or snapshot may show it changed: an input drops line
   * breaks (and an email box trims), Playwright drops zero-width spaces and soft hyphens, trims and collapses white
   * space. Each such form is also remembered as a snapshot's JSON and YAML quoting escapes it and as an address
   * encodes it.
   */
  remember(value: string) {
    const changes = [
      (text: string) => text.replace(/[\r\n]/g, ''),
      (text: string) => text.replace(/[\u200b\u00ad]/g, ''),
      (text: string) => text.replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, ''),
      (text: string) => text.trim(),
      (text: string) => text.replace(/\s+/g, ' '),
    ];
    const shown = new Set([value]);
    // A set's loop also visits what is added during it, so this applies every combination of changes.
    for (const text of shown) for (const change of changes) shown.add(change(text));
    const forms = new Set<string>();
    for (const text of shown) {
      // A changed form too short to mean anything would blank out ordinary text.
      if (text !== value && text.length < 4) continue;
      const json = JSON.stringify(text).slice(1, -1);
      forms.add(text);
      forms.add(json);
      forms.add(json.replace(/'/g, "''"));
      forms.add(yamlEscape(text));
      forms.add(encodeURIComponent(text));
      forms.add(new URLSearchParams({ v: text }).toString().slice(2));
    }
    this.typed = [...new Set([...forms, ...this.typed])]
      .filter(form => form.length)
      .slice(0, 400)
      .sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    let redacted = text;
    for (const value of this.typed) redacted = redacted.split(value).join('••••');
    return redacted;
  }

  state(): BrowserSessionState {
    return {
      sessionId: this.id,
      url: this.redact(this.page.url()),
      title: this.redact(this.title),
      controller: this.controller,
      needsPerson: this.needsPerson,
      controlledBy: this.controlledBy,
      signIn: this.signIn,
      logins: [...this.logins.values()],
    };
  }

  async refreshTitle() {
    this.title = await this.page.title().catch(() => '');
  }

  emit(event: SessionEvent) {
    for (const listener of this.listeners) listener(event);
  }

  async emitState() {
    await this.refreshTitle();
    this.emit({ type: 'state', state: this.state() });
  }

  /** Live frames are not redacted: they go to the chat's member, who gave TulipFarm any secret typed here. */
  async subscribe(listener: Listener): Promise<() => void> {
    this.listeners.add(listener);
    listener({ type: 'state', state: this.state() });
    if (this.lastFrame) listener({ type: 'frame', frame: this.lastFrame });
    else {
      const data = (await this.page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null))?.toString('base64');
      if (data) listener({ type: 'frame', frame: { data, ...browserViewport } });
    }
    await this.startScreencast();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) void this.stopScreencast();
    };
  }

  async session(): Promise<CDPSession> {
    if (this.cdp) return this.cdp;
    const cdp = await this.context.newCDPSession(this.page);
    // One frame handler per CDP session; screencasting starts and stops many times on it.
    cdp.on('Page.screencastFrame', frame => {
      void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
      this.lastFrame = {
        data: frame.data,
        width: frame.metadata.deviceWidth ?? browserViewport.width,
        height: frame.metadata.deviceHeight ?? browserViewport.height,
      };
      this.emit({ type: 'frame', frame: this.lastFrame });
    });
    this.cdp = cdp;
    return cdp;
  }

  private async startScreencast() {
    if (this.screencasting) return;
    this.screencasting = true;
    const cdp = await this.session();
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: browserViewport.width,
      maxHeight: browserViewport.height,
    });
  }

  private async stopScreencast() {
    if (!this.screencasting || !this.cdp) return;
    this.screencasting = false;
    await this.cdp.send('Page.stopScreencast').catch(() => undefined);
  }

  /** Follows a new tab or popup, so the agent and the live view act on the page the site opened. */
  async switchTo(page: Page) {
    const watching = this.screencasting;
    await this.stopScreencast();
    await this.cdp?.detach().catch(() => undefined);
    this.cdp = undefined;
    this.lastFrame = undefined;
    this.page = page;
    if (watching) await this.startScreencast();
    await this.emitState();
  }

  async close() {
    this.listeners.clear();
    await this.context.close().catch(() => undefined);
  }
}

const markerPrefix = '__tulipfarm_login_';
const loadMarker = `${markerPrefix}load`;
/** Whether two sites can share sign-in cookies: one is the other or its parent. */
const sitesOverlap = (a: string, b: string) => siteIncludes(a, b) || siteIncludes(b, a);

export type BrowserHost = Awaited<ReturnType<typeof createBrowserHost>>;

function frameOf(request: Request) {
  try {
    return request.frame();
  } catch {
    return undefined;
  }
}

/** The notice for a page outside the allowed sites, naming up to five of them. */
export function blockedNotice(origin: string, sites: readonly string[]) {
  const named = sites.slice(0, 5).join(', ');
  const more = sites.length > 5 ? ` and ${sites.length - 5} more` : '';
  return `Blocked ${origin}: this browser can only open ${named}${more}.`;
}

export async function createBrowserHost(options: HostOptions) {
  const now = options.now ?? Date.now;
  const snapshotChars = options.snapshotChars ?? 24_000;
  const sessions = new Map<string, Session>();
  const opening = new Map<string, Promise<Session>>();
  let browser: Promise<Browser> | undefined;
  const allowAddress = options.allowAddress ?? publicAddress;
  const egress = options.allowPrivateNetworks ? undefined : await startEgressProxy({ allowed: allowAddress });
  const resolved = new Map<string, { publicOnly: boolean; at: number }>();

  const launch = () => {
    browser ??= chromium
      .launch({
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
        chromiumSandbox: options.sandbox ?? false,
        // Every connection, loopback included, goes through the egress proxy. QUIC and direct WebRTC UDP would not.
        ...(egress ? { proxy: { server: egress.server, bypass: '<-loopback>' } } : {}),
        args: [
          '--no-first-run',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-dev-shm-usage',
          '--disable-quic',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        ],
      })
      .then(started => {
        started.on('disconnected', () => {
          browser = undefined;
          for (const session of sessions.values()) void session.close();
          sessions.clear();
        });
        return started;
      })
      .catch(error => {
        browser = undefined;
        throw error;
      });
    return browser;
  };

  async function publicHost(hostname: string): Promise<boolean> {
    if (options.allowPrivateNetworks) return true;
    const host = hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) return allowAddress(host);
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return false;
    const cached = resolved.get(host);
    if (cached && now() - cached.at < 60_000) return cached.publicOnly;
    let publicOnly = false;
    try {
      const addresses = await lookup(host, { all: true, verbatim: true });
      publicOnly = addresses.length > 0 && addresses.every(({ address }) => allowAddress(address));
    } catch {
      publicOnly = false;
    }
    resolved.set(host, { publicOnly, at: now() });
    return publicOnly;
  }

  function get(sessionId: string): Session {
    const session = sessions.get(sessionId);
    if (!session) throw new HostError('session-not-found', 'No browser session has this ID. Open one first.', 404);
    session.lastUsed = now();
    return session;
  }

  async function create(sessionId: string, allowedSites: readonly string[] | undefined): Promise<Session> {
    if (sessions.size + opening.size >= options.maxSessions)
      throw new HostError('capacity', 'The browser host is running as many sessions as it can. Try again soon.', 503);
    const started = await launch();
    // Routes don't see redirect hops, so a limited session gets its own egress proxy that refuses other sites on every
    // hop, as well as private addresses unless the host allows them.
    const limit = allowedSites
      ? await startEgressProxy({
          allowed: options.allowPrivateNetworks ? () => true : allowAddress,
          host: hostname => siteAllows(allowedSites, hostname),
        })
      : undefined;
    const context = await started
      .newContext({
        ...(limit ? { proxy: { server: limit.server, bypass: '<-loopback>' } } : {}),
        viewport: browserViewport,
        acceptDownloads: false,
        serviceWorkers: 'block',
        locale: 'en-US',
        timezoneId: 'UTC',
      })
      .catch(async error => {
        await limit?.close();
        throw error;
      });
    if (limit) context.on('close', () => void limit.close());
    let session: Session | undefined;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return route.continue();
      const request = route.request();
      // A popup's first request comes before its frame exists, so it counts as no frame.
      const frame = request.isNavigationRequest() ? frameOf(request) : undefined;
      // Limited to listed sites, nothing reaches another site: no page, popup, frame, or resource.
      if (allowedSites && !siteAllows(allowedSites, url.hostname)) {
        if (session && frame === session.page.mainFrame()) session.notice = blockedNotice(url.origin, allowedSites);
        return route.abort('blockedbyclient');
      }
      if ((url.protocol === 'http:' || url.protocol === 'https:') && (await publicHost(url.hostname)))
        return route.continue();
      if (session && frame === session.page.mainFrame())
        session.notice = `Blocked ${url.origin}: the browser only opens public websites.`;
      return route.abort('blockedbyclient');
    });
    // Page routes don't see WebSockets, so they get the same checks here.
    await context.routeWebSocket(/.*/, async socket => {
      const url = new URL(socket.url());
      if (allowedSites && !siteAllows(allowedSites, url.hostname)) return socket.close();
      if (!(await publicHost(url.hostname))) return socket.close();
      socket.connectToServer();
    });
    const page = await context.newPage();
    session = new Session(sessionId, context, page, now());
    const opened = session;
    context.on('page', added => {
      void added.waitForLoadState('domcontentloaded').catch(() => undefined);
      void opened.switchTo(added);
      added.on('close', () => {
        const remaining = context.pages().filter(open => !open.isClosed());
        const last = remaining.at(-1);
        if (opened.page === added && last) void opened.switchTo(last);
      });
    });
    // The proxy refuses a redirect to another site; the agent hears why, as for a link to it.
    if (allowedSites)
      context.on('request', request => {
        if (!request.redirectedFrom() || frameOf(request) !== opened.page.mainFrame()) return;
        const url = URL.parse(request.url());
        if (url && !siteAllows(allowedSites, url.hostname)) opened.notice = blockedNotice(url.origin, allowedSites);
      });
    page.on('framenavigated', frame => {
      if (frame === opened.page.mainFrame()) void opened.emitState();
    });
    return session;
  }

  /** Opens a session, or returns the open one. Allowed sites apply only when the session is created. */
  async function open(sessionId: string, allowedSites?: readonly string[]): Promise<BrowserSessionState> {
    const existing = sessions.get(sessionId);
    if (existing) {
      existing.lastUsed = now();
      return existing.state();
    }
    let pending = opening.get(sessionId);
    if (!pending) {
      pending = create(sessionId, allowedSites);
      opening.set(sessionId, pending);
    }
    try {
      const session = await pending;
      sessions.set(sessionId, session);
      return session.state();
    } finally {
      opening.delete(sessionId);
    }
  }

  async function result(session: Session): Promise<BrowserActionResult> {
    const page = session.page;
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
    let snapshot = '';
    try {
      snapshot = await page.ariaSnapshot({ mode: 'ai', timeout: 10_000 });
    } catch {
      snapshot = '(The page could not be read. Take a snapshot again after it loads.)';
    }
    const truncated = snapshot.length > snapshotChars;
    // Redaction covers text, not pixels, and a page can draw a typed secret anywhere, so after one is typed the
    // agent gets no screenshots from this browser.
    const withheld = session.hasTypedSecret;
    const screenshot = withheld
      ? undefined
      : (await page.screenshot({ type: 'jpeg', quality: 55, timeout: 10_000 })).toString('base64');
    await session.refreshTitle();
    const notices = [
      session.notice && session.redact(session.notice),
      withheld &&
        'Screenshots are off in this browser after a sign-in with a secret. The accessibility snapshot still works.',
    ].filter(Boolean);
    session.notice = undefined;
    snapshot = session.redact(snapshot);
    return {
      state: session.state(),
      snapshot: truncated ? `${snapshot.slice(0, snapshotChars)}\n… (snapshot truncated)` : snapshot,
      truncated,
      ...(screenshot ? { screenshot } : {}),
      ...(notices.length ? { notice: notices.join(' ') } : {}),
    };
  }

  async function act(sessionId: string, action: BrowserAction): Promise<BrowserActionResult> {
    const session = get(sessionId);
    return session.run(() => perform(session, action));
  }

  async function perform(session: Session, action: BrowserAction): Promise<BrowserActionResult> {
    if (session.controller === 'person')
      throw new HostError(
        'person-in-control',
        'A member has taken over this browser. Wait until they hand it back before acting.',
        409,
      );
    session.needsPerson = null;
    session.signIn = null;
    const page = session.page;
    const element = (ref: string) => page.locator(`aria-ref=${ref}`);
    if (
      'ref' in action &&
      !(await element(action.ref)
        .count()
        .catch(() => 0))
    )
      throw new HostError('ref-not-found', `No element has ref ${action.ref}. Take a new snapshot.`, 422);
    try {
      switch (action.action) {
        case 'navigate':
          await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(error => {
            if (!session.notice) throw error;
          });
          await page.waitForLoadState('load', { timeout: 5_000 }).catch(() => undefined);
          break;
        case 'snapshot':
          break;
        case 'click':
          await element(action.ref).click({ timeout: 10_000 });
          await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
          break;
        case 'type':
          await element(action.ref).fill(action.text, { timeout: 10_000 });
          if (action.submit) await element(action.ref).press('Enter', { timeout: 10_000 });
          break;
        case 'press':
          await page.keyboard.press(action.key);
          break;
        case 'select':
          await element(action.ref).selectOption(action.values, { timeout: 10_000 });
          break;
        case 'scroll':
          await page.mouse.wheel(0, action.direction === 'down' ? 600 : -600);
          break;
        case 'back':
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 });
          break;
        case 'wait':
          await page.waitForTimeout(action.seconds * 1000);
          break;
      }
    } catch (error) {
      const message = session.redact((error as Error).message.split('\n')[0] ?? 'The action failed.');
      if ('ref' in action && /aria-ref|resolved to 0 elements|No node found/i.test((error as Error).message))
        throw new HostError('ref-not-found', `No element has ref ${action.ref}. Take a new snapshot.`, 422);
      throw new HostError('action-failed', message, 422);
    }
    await page.waitForTimeout(300);
    return result(session);
  }

  /** Whether a page or frame address is on one of a secret's hosts, over https or, in local tests, http. */
  function onHosts(url: string, hosts: ReadonlySet<string>) {
    try {
      const { protocol, hostname } = new URL(url);
      if (protocol !== 'https:' && !(protocol === 'http:' && options.allowPrivateNetworks)) return false;
      return hosts.has(hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  async function typeSecret(sessionId: string, input: BrowserTypeSecret): Promise<BrowserActionResult> {
    const session = get(sessionId);
    return session.run(async () => {
      if (session.controller === 'person')
        throw new HostError(
          'person-in-control',
          'A member has taken over this browser. Wait until they hand it back before acting.',
          409,
        );
      session.needsPerson = null;
      session.signIn = null;
      const page = session.page;
      const hosts = new Set(input.hosts.map(host => host.toLowerCase()));
      if (!onHosts(page.url(), hosts))
        throw new HostError(
          'destination-denied',
          'This page is not on a site the secret may be used on, so nothing was typed.',
          403,
        );
      // Every field is checked before anything is typed. Playwright's messages are never returned: they can echo a value.
      const resolve = async (ref: string) => {
        const handle = await page
          .locator(`aria-ref=${ref}`)
          .elementHandle({ timeout: 2_000 })
          .catch(() => null);
        if (!handle) throw new HostError('ref-not-found', `No element has ref ${ref}. Take a new snapshot.`, 422);
        const frame = await handle.ownerFrame();
        if (!frame || !onHosts(frame.url(), hosts))
          throw new HostError(
            'destination-denied',
            `Element ${ref} is in a frame from another site, so nothing was typed.`,
            403,
          );
        return handle;
      };
      const fields = [];
      for (const field of input.fields) {
        const handle = await resolve(field.ref);
        const type = await handle
          .evaluate(element =>
            element.tagName === 'INPUT' ? (element as unknown as { type: string }).type.toLowerCase() : null,
          )
          .catch(() => null);
        const fits =
          field.kind === 'password' ? type === 'password' : type === 'text' || type === 'email' || type === 'tel';
        if (!fits)
          throw new HostError(
            'field-refused',
            field.kind === 'password'
              ? `Element ${field.ref} is not a password box. Point at the page's password box.`
              : `Element ${field.ref} is not a text box for the username. Point at the username or email box.`,
            422,
          );
        fields.push({ handle, field });
      }
      const submit = input.submit === undefined ? undefined : await resolve(input.submit);
      const http = Boolean(options.allowPrivateNetworks);
      try {
        for (const { handle, field } of fields) {
          session.remember(field.value);
          // Set in the element's own document in one step, not typed through the keyboard, so a frame that takes
          // focus can't receive it. The checks repeat there in case the page changed since they first ran.
          const typed = await handle.evaluate(
            (element, { value, kind, hosts, http }) => {
              const input = element as unknown as {
                isConnected: boolean;
                tagName: string;
                type: string;
                ownerDocument: { location: { protocol: string; hostname: string } } | null;
                style: { setProperty(name: string, value: string): void };
                dispatchEvent(event: unknown): boolean;
              };
              const location = input.ownerDocument?.location;
              if (!input.isConnected || input.tagName !== 'INPUT' || !location) return false;
              if (location.protocol !== 'https:' && !(http && location.protocol === 'http:')) return false;
              if (!hosts.includes(location.hostname.toLowerCase())) return false;
              const type = input.type.toLowerCase();
              if (kind === 'password' ? type !== 'password' : !['text', 'email', 'tel'].includes(type)) return false;
              const scope = globalThis as unknown as {
                HTMLInputElement: { prototype: object };
                Event: new (type: string, init: { bubbles: boolean }) => unknown;
              };
              // The native setter, so frameworks that track an input's value (React) see the change.
              Object.getOwnPropertyDescriptor(scope.HTMLInputElement.prototype, 'value')?.set?.call(input, value);
              input.dispatchEvent(new scope.Event('input', { bubbles: true }));
              input.dispatchEvent(new scope.Event('change', { bubbles: true }));
              // Hides the username in screenshots too; a password box already hides its value.
              if (kind === 'username') input.style.setProperty('-webkit-text-security', 'disc');
              return true;
            },
            { value: field.value, kind: field.kind, hosts: [...hosts], http },
          );
          if (!typed)
            throw new HostError(
              'action-failed',
              'The sign-in form changed before the secret was typed. Take a new snapshot.',
              422,
            );
        }
        if (submit) {
          await submit.click({ timeout: 10_000 });
          await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
        }
      } catch (error) {
        if (error instanceof HostError) throw error;
        throw new HostError('action-failed', 'The sign-in form could not be filled in or sent.', 422);
      }
      await page.waitForTimeout(300);
      return result(session);
    });
  }

  async function control(sessionId: string, input: BrowserControl): Promise<BrowserSessionState> {
    const session = get(sessionId);
    return session.run(async () => {
      if (input.controller === 'person') {
        session.controller = 'person';
        session.controlledBy = input.memberId;
      } else {
        // A person who hands back after a sign-in request has signed in again, so the site's logins are current.
        if (session.signIn)
          for (const login of session.logins.values())
            if (sitesOverlap(login.site, session.signIn)) login.signedOut = false;
        session.controller = 'agent';
        session.controlledBy = null;
        session.needsPerson = null;
        session.signIn = null;
      }
      await session.emitState();
      return session.state();
    });
  }

  async function needsPerson(sessionId: string, request: BrowserNeedsPerson): Promise<BrowserSessionState> {
    const session = get(sessionId);
    session.needsPerson = request.reason;
    session.signIn = request.signIn ?? null;
    // Asked to sign in to a site whose login is loaded, the login has signed out.
    if (session.signIn)
      for (const login of session.logins.values()) if (sitesOverlap(login.site, session.signIn)) login.signedOut = true;
    await session.emitState();
    return session.state();
  }

  async function loadLogin(sessionId: string, login: BrowserLoadLogin): Promise<BrowserSessionState> {
    const session = get(sessionId);
    return session.run(async () => {
      // A login replaces the site's sign-in, so a login loaded earlier for it no longer describes this browser.
      for (const loaded of session.logins.values())
        if (sitesOverlap(loaded.site, login.site)) session.logins.delete(loaded.id);
      for (const cookie of await session.context.cookies())
        if (siteIncludes(login.site, cookie.domain))
          await session.context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
      const cookies = login.state.cookies.filter(cookie => siteIncludes(login.site, cookie.domain));
      if (cookies.length) await session.context.addCookies(cookies);
      const load = ++session.loads;
      for (const { origin, localStorage } of login.state.origins) {
        if (!siteIncludes(login.site, new URL(origin).hostname) || !localStorage.length) continue;
        // Storage is replaced once per origin and load, on its first page, so the site's later changes are kept and
        // an earlier load's script never applies again.
        await session.context.addInitScript(
          ({ origin, items, marker, load }) => {
            // This runs in the page, where the DOM's globals exist.
            const page = globalThis as unknown as {
              location: { origin: string };
              localStorage: {
                getItem(name: string): string | null;
                setItem(name: string, value: string): void;
                clear(): void;
              };
            };
            if (page.location.origin !== origin || Number(page.localStorage.getItem(marker) ?? 0) >= load) return;
            page.localStorage.clear();
            for (const { name, value } of items) page.localStorage.setItem(name, value);
            page.localStorage.setItem(marker, String(load));
          },
          { origin: new URL(origin).origin, items: localStorage, marker: loadMarker, load },
        );
      }
      session.logins.set(login.id, { id: login.id, site: login.site, signedOut: false });
      session.needsPerson = null;
      session.signIn = null;
      const site = browserSiteOf(session.page.url());
      if (site && siteIncludes(login.site, site))
        await session.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
      await session.emitState();
      return session.state();
    });
  }

  async function siteState(sessionId: string, site: string): Promise<BrowserSiteState> {
    const session = get(sessionId);
    return session.run(async () => {
      const state = await session.context.storageState();
      return {
        cookies: state.cookies
          .filter(cookie => siteIncludes(site, cookie.domain))
          .map(({ name, value, domain, path, expires, httpOnly, secure, sameSite }) => ({
            name,
            value,
            domain,
            path,
            expires,
            httpOnly,
            secure,
            sameSite,
          })),
        origins: state.origins
          .filter(({ origin }) => siteIncludes(site, new URL(origin).hostname))
          .map(({ origin, localStorage }) => ({
            origin,
            localStorage: localStorage.filter(({ name }) => !name.startsWith(markerPrefix)),
          })),
      };
    });
  }

  async function input(sessionId: string, events: BrowserInputs): Promise<void> {
    const session = get(sessionId);
    return session.run(async () => {
      for (const event of Array.isArray(events) ? events : [events]) await dispatch(session, event);
    });
  }

  async function dispatch(session: Session, event: BrowserInput): Promise<void> {
    if (session.controller !== 'person')
      throw new HostError('agent-in-control', 'Take over the browser before using it.', 409);
    const cdp = await session.session();
    switch (event.type) {
      case 'mouse':
        await cdp.send('Input.dispatchMouseEvent', {
          type: event.event,
          x: event.x,
          y: event.y,
          button: event.event === 'mouseMoved' ? 'none' : event.button,
          clickCount: event.event === 'mouseMoved' ? 0 : event.clickCount,
          modifiers: event.modifiers,
        });
        break;
      case 'wheel':
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: event.x,
          y: event.y,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
        });
        break;
      case 'key':
        await cdp.send('Input.dispatchKeyEvent', {
          type: event.event === 'keyDown' && !event.text ? 'rawKeyDown' : event.event,
          key: event.key,
          code: event.code,
          modifiers: event.modifiers,
          ...(event.text ? { text: event.text, unmodifiedText: event.text } : {}),
          ...(event.key.length === 1 ? {} : { windowsVirtualKeyCode: virtualKeyCodes[event.key] ?? 0 }),
        });
        break;
      case 'text':
        await cdp.send('Input.insertText', { text: event.text });
        break;
    }
  }

  async function subscribe(sessionId: string, listener: Listener): Promise<() => void> {
    const session = get(sessionId);
    const unsubscribe = await session.subscribe(listener);
    const keepAlive = setInterval(() => {
      session.lastUsed = now();
    }, 30_000);
    return () => {
      clearInterval(keepAlive);
      unsubscribe();
    };
  }

  async function close(sessionId: string): Promise<void> {
    const session = get(sessionId);
    sessions.delete(sessionId);
    await session.close();
  }

  async function sweep(): Promise<number> {
    let closed = 0;
    for (const [id, session] of sessions) {
      const limit = session.needsPerson || session.controller === 'person' ? options.holdMs : options.idleMs;
      if (now() - session.lastUsed >= limit) {
        sessions.delete(id);
        await session.close();
        closed += 1;
      }
    }
    return closed;
  }

  return {
    open,
    state: async (sessionId: string) => {
      const session = get(sessionId);
      await session.refreshTitle();
      return session.state();
    },
    act,
    typeSecret,
    control,
    needsPerson,
    loadLogin,
    siteState,
    input,
    subscribe,
    close,
    sweep,
    size: () => sessions.size,
    async shutdown() {
      for (const session of sessions.values()) await session.close();
      sessions.clear();
      await (await browser?.catch(() => undefined))?.close();
      await egress?.close();
    },
  };
}

const virtualKeyCodes: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  Meta: 91,
};
