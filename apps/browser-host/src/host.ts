import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import {
  browserViewport,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserControl,
  type BrowserFrame,
  type BrowserHostErrorCode,
  type BrowserInput,
  type BrowserSessionState,
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

class Session {
  readonly id: string;
  readonly context: BrowserContext;
  page: Page;
  controller: 'agent' | 'person' = 'agent';
  controlledBy: string | null = null;
  needsPerson: string | null = null;
  lastUsed: number;
  notice: string | undefined;
  title = '';
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

  state(): BrowserSessionState {
    return {
      sessionId: this.id,
      url: this.page.url(),
      title: this.title,
      controller: this.controller,
      needsPerson: this.needsPerson,
      controlledBy: this.controlledBy,
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

export type BrowserHost = Awaited<ReturnType<typeof createBrowserHost>>;

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

  async function create(sessionId: string): Promise<Session> {
    if (sessions.size + opening.size >= options.maxSessions)
      throw new HostError('capacity', 'The browser host is running as many sessions as it can. Try again soon.', 503);
    const context = await (
      await launch()
    ).newContext({
      viewport: browserViewport,
      acceptDownloads: false,
      serviceWorkers: 'block',
      locale: 'en-US',
      timezoneId: 'UTC',
    });
    let session: Session | undefined;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return route.continue();
      if ((url.protocol === 'http:' || url.protocol === 'https:') && (await publicHost(url.hostname)))
        return route.continue();
      if (session && route.request().isNavigationRequest() && route.request().frame() === session.page.mainFrame())
        session.notice = `Blocked ${url.origin}: the browser only opens public websites.`;
      return route.abort('blockedbyclient');
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
    page.on('framenavigated', frame => {
      if (frame === opened.page.mainFrame()) void opened.emitState();
    });
    return session;
  }

  async function open(sessionId: string): Promise<BrowserSessionState> {
    const existing = sessions.get(sessionId);
    if (existing) {
      existing.lastUsed = now();
      return existing.state();
    }
    let pending = opening.get(sessionId);
    if (!pending) {
      pending = create(sessionId);
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
    const screenshot = (await page.screenshot({ type: 'jpeg', quality: 55, timeout: 10_000 })).toString('base64');
    await session.refreshTitle();
    const notice = session.notice;
    session.notice = undefined;
    return {
      state: session.state(),
      snapshot: truncated ? `${snapshot.slice(0, snapshotChars)}\n… (snapshot truncated)` : snapshot,
      truncated,
      screenshot,
      ...(notice ? { notice } : {}),
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
      const message = (error as Error).message.split('\n')[0] ?? 'The action failed.';
      if ('ref' in action && /aria-ref|resolved to 0 elements|No node found/i.test((error as Error).message))
        throw new HostError('ref-not-found', `No element has ref ${action.ref}. Take a new snapshot.`, 422);
      throw new HostError('action-failed', message, 422);
    }
    await page.waitForTimeout(300);
    return result(session);
  }

  async function control(sessionId: string, input: BrowserControl): Promise<BrowserSessionState> {
    const session = get(sessionId);
    return session.run(async () => {
      if (input.controller === 'person') {
        session.controller = 'person';
        session.controlledBy = input.memberId;
      } else {
        session.controller = 'agent';
        session.controlledBy = null;
        session.needsPerson = null;
      }
      await session.emitState();
      return session.state();
    });
  }

  async function needsPerson(sessionId: string, reason: string): Promise<BrowserSessionState> {
    const session = get(sessionId);
    session.needsPerson = reason;
    await session.emitState();
    return session.state();
  }

  async function input(sessionId: string, event: BrowserInput): Promise<void> {
    const session = get(sessionId);
    return session.run(() => dispatch(session, event));
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
    control,
    needsPerson,
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
