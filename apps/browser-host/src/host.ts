import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIP } from 'node:net';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Download,
  type Frame,
  type Page,
  type Request,
} from 'playwright-core';
import {
  browserFileBytes,
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
  type BrowserUpload,
  browserSiteOf,
  siteAllows,
  siteIncludes,
} from '@tulipfarm/browser/contracts';
import { publicAddress } from '@tulipfarm/workspace-mcp-transport';
import { startEgressProxy } from './egress.ts';

export class HostError extends Error {
  readonly code: BrowserHostErrorCode;
  readonly status: number;
  /** For `browser-busy`: the request's place in its workspace's queue when it stopped waiting. */
  position: number | undefined;
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
  /** Sessions one workspace may run at once. Opening another waits in the workspace's queue. */
  maxSessionsPerWorkspace?: number;
  /** How long opening a session waits in its workspace's queue before it fails with `browser-busy`. */
  queueWaitMs?: number;
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
  /** Largest download kept. Defaults to the largest file in Files. */
  maxDownloadBytes?: number;
  /** How long a step waits for the downloads it started to finish before it returns. */
  downloadWaitMs?: number;
  /** How long a download may take before it is cancelled. */
  downloadTimeoutMs?: number;
  /** How long a finished download waits to be saved before it is deleted. */
  downloadHoldMs?: number;
  /** Most downloads a session may hold or have in progress at once. */
  maxHeldDownloads?: number;
  /** Most bytes a session's held and in-progress downloads may take on disk together. */
  maxHeldDownloadBytes?: number;
  now?: () => number;
};

type Waiter = {
  sessionId: string;
  allowedSites: readonly string[] | undefined;
  /** Open requests for this session waiting in line; the place is given up when the last one ends. */
  requests: number;
  admitted: Promise<{ session: Promise<Session> }>;
  admit(session: Promise<Session>): void;
  fail(error: Error): void;
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
  readonly workspaceId: string | undefined;
  readonly openedAt: number;
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
  /** Finished downloads, kept on disk until the agent's tool takes them to save in Files or they expire. */
  readonly downloads = new Map<
    string,
    { id: string; name: string; size: number; download: Download; expiresAt: number }
  >();
  /** Downloads still in progress, with their names and the work that keeps them when they finish. */
  readonly downloading = new Map<Download, { name: string; work: Promise<void> }>();
  /** The browser's own record of each download in progress, by its id, with the bytes received so far. */
  readonly transfers = new Map<string, { url: string; name: string; received: number; download?: Download }>();
  /** The browser's id for this session's context, which its download events are traced back to. */
  contextId = '';
  /** Why a download was stopped, for the notice the agent gets. */
  readonly stopped = new WeakMap<Download, string>();
  /** What happened to downloads since the agent's last step, such as one too large to keep. */
  downloadNotices: string[] = [];
  /** Every form of the secrets typed in this session, longest first, to keep out of what the host returns. */
  private typed: string[] = [];
  private cdp: CDPSession | undefined;
  private screencasting = false;
  private lastFrame: BrowserFrame | undefined;
  private readonly listeners = new Set<Listener>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly limits: { idleMs: number; holdMs: number };

  constructor(
    id: string,
    workspaceId: string | undefined,
    context: BrowserContext,
    page: Page,
    now: number,
    limits: { idleMs: number; holdMs: number },
  ) {
    this.id = id;
    this.workspaceId = workspaceId;
    this.context = context;
    this.page = page;
    this.lastUsed = now;
    this.openedAt = now;
    this.limits = limits;
  }

  /** How long the session stays open unused: longer while it waits for a person or one has taken over. */
  get idleLimit() {
    return this.needsPerson || this.controller === 'person' ? this.limits.holdMs : this.limits.idleMs;
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
    this.dropDownloads();
  }

  /**
   * A page can write a typed secret into a file, and redaction covers only what the host returns as text, so once
   * a secret is typed no download leaves this browser: held ones are deleted and those in progress stopped.
   */
  private dropDownloads() {
    for (const held of this.downloads.values()) {
      void held.download.delete().catch(() => undefined);
      this.downloadNotices.push(notSaved(held.name, secretTyped));
    }
    this.downloads.clear();
    for (const [download, { name }] of this.downloading) this.stop(download, notSaved(name, secretTyped));
  }

  /** Cancels a download in progress, keeping why for the agent's notice. */
  stop(download: Download, reason: string) {
    if (this.stopped.has(download)) return;
    this.stopped.set(download, reason);
    void download.cancel().catch(() => undefined);
  }

  /** Bytes the session's downloads take on disk, held or in progress, leaving out one being checked. */
  downloadBytes(except?: Download) {
    let bytes = 0;
    for (const held of this.downloads.values()) bytes += held.size;
    for (const transfer of this.transfers.values()) if (transfer.download !== except) bytes += transfer.received;
    return bytes;
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
      openedAt: new Date(this.openedAt).toISOString(),
      closesAt: new Date(this.lastUsed + this.idleLimit).toISOString(),
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
    this.downloads.clear();
    await this.context.close().catch(() => undefined);
  }
}

const secretTyped = 'downloads aren’t saved after a password is typed in this browser.';
const tooManyDownloads = 'too many downloads are waiting to be saved.';
const notSaved = (name: string, reason: string) => `"${name}" was not saved: ${reason}`;

type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] };
const hasFrame = (tree: FrameTree, frameId: string): boolean =>
  tree.frame.id === frameId || (tree.childFrames ?? []).some(child => hasFrame(child, frameId));

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
  const maxDownloadBytes = options.maxDownloadBytes ?? browserFileBytes;
  const downloadWaitMs = options.downloadWaitMs ?? 30_000;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? 5 * 60_000;
  const downloadHoldMs = options.downloadHoldMs ?? 5 * 60_000;
  const maxHeldDownloads = options.maxHeldDownloads ?? 20;
  const maxHeldDownloadBytes = options.maxHeldDownloadBytes ?? 2 * maxDownloadBytes;
  const tooLarge = `files are limited to ${Math.floor(maxDownloadBytes / 1024 / 1024)} MiB.`;
  const sessions = new Map<string, Session>();
  const opening = new Map<string, { workspaceId: string | undefined; session: Promise<Session> }>();
  const perWorkspace = options.maxSessionsPerWorkspace ?? Number.POSITIVE_INFINITY;
  const queueWaitMs = options.queueWaitMs ?? 60_000;
  /** Each workspace's requests to open a session, first come first served, while all its browsers are in use. */
  const queues = new Map<string, Waiter[]>();
  let browser: Promise<Browser> | undefined;
  const allowAddress = options.allowAddress ?? publicAddress;
  const egress = options.allowPrivateNetworks ? undefined : await startEgressProxy({ allowed: allowAddress });
  const resolved = new Map<string, { publicOnly: boolean; at: number }>();

  // Downloads in progress the browser reported whose session is still being found, by the browser's id.
  const unclaimed = new Map<string, { url: string; name: string; received: number; frameId: string }>();
  // The browser context of every page and frame the host has seen, kept for a while after the frame is gone, so a
  // download is traced to its session even when the frame that started it was removed straight away.
  const frameContexts = new Map<string, string>();
  // When each frame that is gone was removed, oldest first. A download no session can be found for is stopped, so
  // forgetting a frame only stops a download it starts after this long.
  const removedFrames = new Map<string, number>();
  const removedFrameMs = 60_000;
  const maxRemovedFrames = 2000;

  function trackFrame(frameId: string, contextId: string) {
    frameContexts.set(frameId, contextId);
    removedFrames.delete(frameId);
  }

  function removeFrames(frameIds: Iterable<string>) {
    for (const frameId of frameIds) {
      if (!frameContexts.has(frameId)) continue;
      removedFrames.delete(frameId);
      removedFrames.set(frameId, now());
    }
    forgetFrames();
  }

  /** Forgets frames removed over a minute ago, and the oldest beyond the cap for a context. */
  function forgetFrames() {
    const needed = new Set([...unclaimed.values()].map(transfer => transfer.frameId));
    const counts = new Map<string, number>();
    for (const frameId of removedFrames.keys()) {
      const contextId = frameContexts.get(frameId) ?? '';
      counts.set(contextId, (counts.get(contextId) ?? 0) + 1);
    }
    for (const [frameId, at] of removedFrames) {
      if (needed.has(frameId)) continue;
      const contextId = frameContexts.get(frameId) ?? '';
      const count = counts.get(contextId) ?? 0;
      if (now() - at < removedFrameMs && count <= maxRemovedFrames) continue;
      removedFrames.delete(frameId);
      frameContexts.delete(frameId);
      counts.set(contextId, count - 1);
    }
  }
  // Downloads stopped because no session could be found for them, by address and file name, so the session
  // Playwright reports them to gets the reason.
  const untraced = new Set<string>();
  // The browser's own download events cover every context and tab, so a download a new tab starts before the host
  // could watch that tab is still stopped mid-transfer.
  let monitor: Promise<{ cdp: CDPSession; downloadsPath: string }> | undefined;

  const sessionIn = (contextId: string | undefined) =>
    contextId ? [...sessions.values()].find(session => session.contextId === contextId) : undefined;

  async function watchDownloads(cdp: CDPSession, downloadsPath: string) {
    cdp.on('Target.targetCreated', ({ targetInfo }) => {
      if (targetInfo.browserContextId) trackFrame(targetInfo.targetId, targetInfo.browserContextId);
    });
    cdp.on('Target.targetDestroyed', ({ targetId }) => removeFrames([targetId]));
    cdp.on('Browser.downloadWillBegin', event => {
      const transfer = { url: event.url, name: event.suggestedFilename, received: 0, frameId: event.frameId };
      const known = sessionIn(frameContexts.get(event.frameId));
      if (known) {
        known.transfers.set(event.guid, transfer);
        link(known);
        return;
      }
      unclaimed.set(event.guid, transfer);
      void ownerOf(cdp, event.frameId).then(owner => {
        if (!unclaimed.delete(event.guid)) return;
        if (owner) {
          owner.transfers.set(event.guid, transfer);
          link(owner);
          return;
        }
        // A download no session can be found for is never let through unbounded.
        untraced.add(`${transfer.url}\n${transfer.name}`);
        const contexts = new Set([...sessions.values()].map(session => session.contextId));
        const contextId = frameContexts.get(event.frameId);
        if (contextId) contexts.add(contextId);
        void Promise.allSettled(
          [...contexts].map(browserContextId =>
            cdp.send('Browser.cancelDownload', { guid: event.guid, browserContextId }),
          ),
        ).then(() => rm(join(downloadsPath, event.guid), { force: true }));
      });
    });
    cdp.on('Browser.downloadProgress', event => {
      const owner = [...sessions.values()].find(session => session.transfers.has(event.guid));
      const transfer = owner?.transfers.get(event.guid) ?? unclaimed.get(event.guid);
      if (!transfer) return;
      if (event.state !== 'inProgress') {
        unclaimed.delete(event.guid);
        owner?.transfers.delete(event.guid);
        return;
      }
      transfer.received = Math.max(event.receivedBytes, event.totalBytes);
      if (owner) checkTransfer(owner, transfer);
    });
    await cdp.send('Target.setDiscoverTargets', { discover: true });
  }

  /**
   * Finds the session a download's frame belongs to when it wasn't seen being created: a page or an iframe in its
   * own process is a browser target, and any other iframe is looked up in its page's frame tree.
   */
  async function ownerOf(cdp: CDPSession, frameId: string) {
    const known = sessionIn(frameContexts.get(frameId));
    if (known) return known;
    const { targetInfos } = await cdp.send('Target.getTargets').catch(() => ({ targetInfos: [] }));
    const target = targetInfos.find(info => info.targetId === frameId);
    if (target) return sessionIn(target.browserContextId);
    for (const session of sessions.values())
      for (const page of session.context.pages()) {
        const pageCdp = await session.context.newCDPSession(page).catch(() => undefined);
        if (!pageCdp) continue;
        const { frameTree } = await pageCdp.send('Page.getFrameTree').catch(() => ({ frameTree: undefined }));
        await pageCdp.detach().catch(() => undefined);
        if (frameTree && hasFrame(frameTree, frameId)) return session;
      }
    return undefined;
  }

  /**
   * Records the context of a page's frames as they are attached, including ones already there. Closing a page sends
   * no removal for its own iframes, so they are all removed with it.
   */
  async function trackFrames(context: BrowserContext, contextId: string, page: Page) {
    const frames = new Set<string>();
    const track = (frameId: string) => {
      frames.add(frameId);
      trackFrame(frameId, contextId);
    };
    page.once('close', () => {
      removeFrames(frames);
      frames.clear();
    });
    const cdp = await context.newCDPSession(page).catch(() => undefined);
    if (!cdp) return;
    cdp.on('Page.frameAttached', event => track(event.frameId));
    cdp.on('Page.frameNavigated', event => track(event.frame.id));
    // A frame swapped into its own process lives on as a browser target, so only a removal counts.
    cdp.on('Page.frameDetached', event => {
      if (event.reason !== 'remove') return;
      frames.delete(event.frameId);
      removeFrames([event.frameId]);
    });
    await cdp.send('Page.enable').catch(() => undefined);
    const { frameTree } = await cdp.send('Page.getFrameTree').catch(() => ({ frameTree: undefined }));
    const add = (tree: FrameTree) => {
      track(tree.frame.id);
      for (const child of tree.childFrames ?? []) add(child);
    };
    if (frameTree) add(frameTree);
    if (page.isClosed()) removeFrames(frames);
  }

  const launch = () => {
    browser ??= (async () => {
      const downloadsPath = await mkdtemp(join(tmpdir(), 'tulipfarm-downloads-'));
      const started = await chromium.launch({
        downloadsPath,
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
      });
      started.on('disconnected', () => {
        browser = undefined;
        monitor = undefined;
        unclaimed.clear();
        frameContexts.clear();
        removedFrames.clear();
        void rm(downloadsPath, { recursive: true, force: true });
        for (const session of sessions.values()) void session.close();
        sessions.clear();
        for (const workspaceId of queues.keys()) admitNext(workspaceId);
      });
      monitor = started.newBrowserCDPSession().then(async cdp => {
        await watchDownloads(cdp, downloadsPath);
        return { cdp, downloadsPath };
      });
      await monitor;
      return started;
    })().catch(error => {
      browser = undefined;
      monitor = undefined;
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

  async function create(
    sessionId: string,
    workspaceId: string | undefined,
    allowedSites: readonly string[] | undefined,
  ): Promise<Session> {
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
        acceptDownloads: true,
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
    const contextId = await watchContextDownloads(context, page);
    session = new Session(sessionId, workspaceId, context, page, now(), options);
    session.contextId = contextId;
    await trackFrames(context, contextId, page);
    context.on('close', () => {
      for (const [frameId, owner] of frameContexts)
        if (owner === contextId) {
          frameContexts.delete(frameId);
          removedFrames.delete(frameId);
        }
    });
    const opened = session;
    const watch = (watched: Page) => watched.on('download', download => keep(opened, download));
    watch(page);
    context.on('page', added => {
      watch(added);
      void trackFrames(context, contextId, added);
      // A tab opened only to download a file never shows a page and can't be captured, so follow a tab once it
      // shows something.
      if (added.url()) void opened.switchTo(added);
      else {
        const follow = (frame: Frame) => {
          if (frame !== added.mainFrame() || !frame.url()) return;
          added.off('framenavigated', follow);
          if (!added.isClosed()) void opened.switchTo(added);
        };
        added.on('framenavigated', follow);
      }
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

  /**
   * Turns on the browser's download events for a new context before it opens anything, with the same settings
   * Playwright uses, so its own download handling is unchanged.
   */
  async function watchContextDownloads(context: BrowserContext, page: Page) {
    const { cdp, downloadsPath } = await (monitor ?? Promise.reject(new Error('The browser is not running.')));
    const target = await context.newCDPSession(page);
    const { targetInfo } = await target.send('Target.getTargetInfo');
    await target.detach().catch(() => undefined);
    if (!targetInfo.browserContextId) throw new Error('The browser did not report the page’s context.');
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      browserContextId: targetInfo.browserContextId,
      downloadPath: downloadsPath,
      eventsEnabled: true,
    });
    return targetInfo.browserContextId;
  }

  /**
   * Pairs each download in progress with the browser's record of it, which Playwright reports separately. Both belong
   * to this session already, so only identical downloads in the same session could swap records.
   */
  function link(session: Session) {
    const paired = new Set([...session.transfers.values()].map(transfer => transfer.download));
    for (const transfer of session.transfers.values()) {
      if (transfer.download) continue;
      const download = [...session.downloading.keys()].find(
        candidate =>
          !paired.has(candidate) && candidate.url() === transfer.url && candidate.suggestedFilename() === transfer.name,
      );
      if (!download) continue;
      paired.add(download);
      transfer.download = download;
      checkTransfer(session, transfer);
    }
  }

  function checkTransfer(session: Session, transfer: { received: number; download?: Download }) {
    const download = transfer.download;
    const name = download && session.downloading.get(download)?.name;
    if (!download || !name) return;
    if (transfer.received > maxDownloadBytes) session.stop(download, notSaved(name, tooLarge));
    else if (session.downloadBytes() > maxHeldDownloadBytes) session.stop(download, notSaved(name, tooManyDownloads));
  }

  /** Keeps a page's download once it finishes, unless it is too large or the session already holds too many. */
  function keep(session: Session, download: Download) {
    const name = session.redact(download.suggestedFilename().trim()).slice(-255) || 'download';
    const refused = session.hasTypedSecret
      ? secretTyped
      : session.downloads.size + session.downloading.size >= maxHeldDownloads
        ? tooManyDownloads
        : undefined;
    if (refused) {
      session.downloadNotices.push(notSaved(name, refused));
      void download
        .cancel()
        .then(() => download.delete())
        .catch(() => undefined);
      return;
    }
    const work = (async () => {
      const timer = setTimeout(() => void download.cancel().catch(() => undefined), downloadTimeoutMs);
      try {
        const path = await download.path().catch(() => null);
        const stopped = session.stopped.get(download);
        if (!path || stopped) {
          await download.delete().catch(() => undefined);
          const failed = stopped ? null : await download.failure().catch(() => 'failed');
          const traced = !untraced.delete(`${download.url()}\n${download.suggestedFilename()}`);
          session.downloadNotices.push(
            stopped ??
              (!traced
                ? notSaved(name, 'the browser couldn’t tell which page started it.')
                : failed === 'canceled'
                  ? `The download of "${name}" took too long and was stopped.`
                  : `The download of "${name}" failed.`),
          );
          return;
        }
        const { size } = await stat(path);
        const reason = session.hasTypedSecret
          ? secretTyped
          : size > maxDownloadBytes
            ? tooLarge
            : session.downloads.size >= maxHeldDownloads ||
                session.downloadBytes(download) + size > maxHeldDownloadBytes
              ? tooManyDownloads
              : undefined;
        if (reason) {
          await download.delete().catch(() => undefined);
          session.downloadNotices.push(notSaved(name, reason));
          return;
        }
        const id = randomUUID();
        session.downloads.set(id, { id, name, size, download, expiresAt: now() + downloadHoldMs });
      } finally {
        clearTimeout(timer);
        for (const [guid, transfer] of session.transfers)
          if (transfer.download === download) session.transfers.delete(guid);
      }
    })();
    session.downloading.set(download, { name, work });
    void work.finally(() => session.downloading.delete(download));
    link(session);
  }

  /** Deletes finished downloads that waited too long to be saved, even while the session is in use. */
  function expireDownloads(session: Session) {
    for (const [id, held] of session.downloads) {
      if (now() < held.expiresAt) continue;
      session.downloads.delete(id);
      void held.download.delete().catch(() => undefined);
      session.downloadNotices.push(notSaved(held.name, 'it waited too long to be saved.'));
    }
  }

  /** Sessions a workspace runs or is opening. */
  function inUse(workspaceId: string) {
    let count = 0;
    for (const session of sessions.values()) if (session.workspaceId === workspaceId) count += 1;
    for (const pending of opening.values()) if (pending.workspaceId === workspaceId) count += 1;
    return count;
  }

  function start(sessionId: string, workspaceId: string | undefined, allowedSites: readonly string[] | undefined) {
    const session = create(sessionId, workspaceId, allowedSites).then(
      created => {
        sessions.set(sessionId, created);
        return created;
      },
      error => {
        throw error;
      },
    );
    opening.set(sessionId, { workspaceId, session });
    // A session that failed to open frees its place for the next in line.
    void session
      .finally(() => {
        opening.delete(sessionId);
        if (workspaceId) admitNext(workspaceId);
      })
      .catch(() => undefined);
    return session;
  }

  /** Opens sessions for the first in a workspace's queue while it has browsers free. */
  function admitNext(workspaceId: string) {
    const queue = queues.get(workspaceId);
    while (queue?.length && inUse(workspaceId) < perWorkspace) {
      const waiter = queue.shift()!;
      waiter.admit(start(waiter.sessionId, workspaceId, waiter.allowedSites));
    }
    if (!queue?.length) queues.delete(workspaceId);
  }

  /** Waits in the workspace's queue until a browser is free, the wait runs out, or the request ends. */
  async function queued(
    sessionId: string,
    workspaceId: string,
    allowedSites: readonly string[] | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Session> {
    const queue = queues.get(workspaceId) ?? [];
    queues.set(workspaceId, queue);
    // Requests to open the same session share one place in line.
    let waiter = queue.find(entry => entry.sessionId === sessionId);
    if (!waiter) {
      let admit!: (session: Promise<Session>) => void;
      let fail!: (error: Error) => void;
      const admitted = new Promise<{ session: Promise<Session> }>((resolve, reject) => {
        admit = session => resolve({ session });
        fail = reject;
      });
      waiter = { sessionId, allowedSites, requests: 0, admitted, admit, fail };
      queue.push(waiter);
    }
    const entry = waiter;
    entry.requests += 1;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const leave = () => {
      entry.requests -= 1;
      if (entry.requests > 0) return;
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      if (!queue.length && queues.get(workspaceId) === queue) queues.delete(workspaceId);
    };
    try {
      const { session } = await Promise.race([
        entry.admitted,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const position = queue.indexOf(entry) + 1;
            leave();
            reject(busy(position));
          }, queueWaitMs);
          onAbort = () => {
            leave();
            reject(new HostError('invalid-request', 'The request ended before a browser was free.', 499));
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      return await session;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  function busy(position: number) {
    const browsers =
      perWorkspace === 1
        ? 'The browser for this workspace is in use.'
        : `All ${perWorkspace} browsers for this workspace are in use.`;
    const error = new HostError('browser-busy', `${browsers} This step is number ${position} in line.`, 429);
    error.position = position;
    return error;
  }

  /**
   * Opens a session, or returns the open one. Allowed sites apply only when the session is created. A new session for a
   * workspace that runs all the browsers it may waits in that workspace's queue; an open one never waits.
   */
  async function open(
    sessionId: string,
    allowedSites?: readonly string[],
    workspaceId?: string,
    signal?: AbortSignal,
  ): Promise<BrowserSessionState> {
    const existing = sessions.get(sessionId);
    if (existing) {
      existing.lastUsed = now();
      return existing.state();
    }
    const pending = opening.get(sessionId)?.session;
    if (pending) return (await pending).state();
    if (!workspaceId) return (await start(sessionId, undefined, allowedSites)).state();
    const free = !queues.get(workspaceId)?.length && inUse(workspaceId) < perWorkspace;
    const session = free
      ? await start(sessionId, workspaceId, allowedSites)
      : await queued(sessionId, workspaceId, allowedSites, signal);
    return session.state();
  }

  async function result(session: Session): Promise<BrowserActionResult> {
    const page = session.page;
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
    if (session.downloading.size) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...session.downloading.values()].map(({ work }) => work)),
        new Promise(resolve => (timer = setTimeout(resolve, downloadWaitMs))),
      ]);
      clearTimeout(timer);
    }
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
    expireDownloads(session);
    const notices = [
      session.notice && session.redact(session.notice),
      withheld &&
        'Screenshots are off in this browser after a sign-in with a secret. The accessibility snapshot still works.',
      ...session.downloadNotices,
      session.downloading.size > 0 &&
        'A download is still in progress. Take a snapshot later to save it when it finishes.',
    ].filter(Boolean);
    session.notice = undefined;
    session.downloadNotices = [];
    snapshot = session.redact(snapshot);
    const downloads = [...session.downloads.values()].map(({ id, name, size }) => ({ id, name, size }));
    return {
      state: session.state(),
      snapshot: truncated ? `${snapshot.slice(0, snapshotChars)}\n… (snapshot truncated)` : snapshot,
      truncated,
      ...(screenshot ? { screenshot } : {}),
      ...(notices.length ? { notice: notices.join(' ') } : {}),
      ...(downloads.length ? { downloads } : {}),
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
            // An address that serves a file starts a download instead of a page.
            if (!session.notice && !/Download is starting/i.test((error as Error).message)) throw error;
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

  /**
   * Sets a file on a file input: the element `ref`, the input a label is for, or the only file input inside the
   * element, as sites often hide the input inside a styled upload button. Nothing else is accepted.
   */
  async function upload(sessionId: string, input: BrowserUpload, bytes: Buffer): Promise<BrowserActionResult> {
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
      const handle = await page
        .locator(`aria-ref=${input.ref}`)
        .elementHandle({ timeout: 2_000 })
        .catch(() => null);
      if (!handle) throw new HostError('ref-not-found', `No element has ref ${input.ref}. Take a new snapshot.`, 422);
      const target = (
        await handle
          .evaluateHandle(element => {
            type Node = {
              tagName: string;
              type?: string;
              control?: Node | null;
              querySelectorAll(selector: string): ArrayLike<Node>;
            };
            const fileInput = (node: Node | null | undefined) =>
              node?.tagName === 'INPUT' && node.type?.toLowerCase() === 'file' ? node : null;
            const node = element as unknown as Node;
            const inside = node.querySelectorAll('input[type=file]');
            return (
              fileInput(node) ??
              (node.tagName === 'LABEL' ? fileInput(node.control) : null) ??
              (inside.length === 1 ? inside[0]! : null)
            );
          })
          .catch(() => null)
      )?.asElement();
      if (!target)
        throw new HostError(
          'field-refused',
          `Element ${input.ref} is not a file upload box. Point at the page's file input or its upload button.`,
          422,
        );
      try {
        await target.setInputFiles({ name: input.name, mimeType: input.mediaType, buffer: bytes }, { timeout: 10_000 });
      } catch (error) {
        throw new HostError(
          'action-failed',
          session.redact((error as Error).message.split('\n')[0] ?? 'The file could not be set.'),
          422,
        );
      }
      await page.waitForTimeout(300);
      return result(session);
    });
  }

  /** Hands a finished download over once. The caller deletes it with `done` after reading it. */
  function takeDownload(sessionId: string, downloadId: string) {
    const session = get(sessionId);
    expireDownloads(session);
    const held = session.downloads.get(downloadId);
    if (!held) throw new HostError('download-not-found', 'No download with this ID is waiting.', 404);
    session.downloads.delete(downloadId);
    return {
      name: held.name,
      size: held.size,
      read: () => held.download.createReadStream(),
      done: () => held.download.delete().catch(() => undefined),
    };
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
    if (session.workspaceId) admitNext(session.workspaceId);
    await session.close();
  }

  async function sweep(): Promise<number> {
    let closed = 0;
    forgetFrames();
    for (const [id, session] of sessions) {
      expireDownloads(session);
      if (now() - session.lastUsed >= session.idleLimit) {
        sessions.delete(id);
        if (session.workspaceId) admitNext(session.workspaceId);
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
    upload,
    takeDownload,
    control,
    needsPerson,
    loadLogin,
    siteState,
    input,
    subscribe,
    close,
    sweep,
    size: () => sessions.size,
    /** How many pages and frames the host is tracking, so tests can see removed ones are forgotten. */
    trackedFrames: () => frameContexts.size,
    async shutdown() {
      for (const queue of queues.values())
        for (const waiter of queue)
          waiter.fail(new HostError('capacity', 'The browser host is shutting down. Try again soon.', 503));
      queues.clear();
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
