/**
 * Dev-only mock of ChatGPT, Claude, GitHub Copilot and GitHub logins, so their connect flows can be clicked through
 * locally without real accounts. Open any page in the `seed-github-ux` workspace with `?planMock=<scenario>`:
 * `empty`, `one`, `many` or `attention`. The state lives in localStorage, so it survives navigation and is shared
 * with the fake sign-in tabs; `?planMock=off` turns it off. Sign-in opens a fake provider page at `/mock-provider`.
 */

import { loadOwnMembership } from '../../lib/governance';
const storageKey = 'tf-plan-mock';
const local = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const param = new URLSearchParams(window.location.search).get('planMock');

type Plan = 'chatgpt' | 'claude' | 'copilot';
type State = 'connected' | 'reconnect-required';
type PlanAccount = {
  connectionId: string;
  provider: Plan;
  account: string;
  plan: string;
  state: State;
  chat: boolean;
  coding: boolean;
  githubAccountId: string | null;
  createdAt: string;
};
type Login = {
  id: string;
  login: string;
  state: 'active' | 'reconnect-required';
  chat: boolean;
  coding: boolean;
  primary: boolean;
};
type Attempt = {
  provider: Plan | 'github';
  renew: string | null;
  status: 'pending' | 'completed' | 'failed';
  error: string | null;
};
type Mock = {
  plans: PlanAccount[];
  logins: Login[];
  attempts: Record<string, Attempt>;
  grants: Record<string, unknown[]>;
};

/** Who the fake provider pages offer to sign in as. Free accounts fail the plan check, like the real providers. */
export const mockPeople: Record<Plan | 'github', { account: string; plan: string | null }[]> = {
  chatgpt: [
    { account: 'ada@acme.co', plan: 'Plus' },
    { account: 'codex-bot@acme.co', plan: 'Pro' },
    { account: 'free@acme.co', plan: null },
  ],
  claude: [
    { account: 'ada@acme.co', plan: 'Max' },
    { account: 'coding-bot@acme.co', plan: 'Pro' },
    { account: 'free@acme.co', plan: null },
  ],
  copilot: [
    { account: 'dev-user', plan: 'Copilot Pro' },
    { account: 'acme-bot', plan: 'Copilot Business' },
    { account: 'no-copilot', plan: null },
  ],
  github: [
    { account: 'dev-user', plan: 'Personal' },
    { account: 'acme-bot', plan: 'Bot account' },
    { account: 'ada-indexer', plan: 'Indexing account' },
  ],
};

const models: Record<Plan, { slug: string; label: string }[]> = {
  chatgpt: [
    { slug: 'gpt-5.5', label: 'GPT-5.5' },
    { slug: 'gpt-5.5-codex', label: 'GPT-5.5 Codex' },
  ],
  claude: [
    { slug: 'claude-opus', label: 'Claude Opus' },
    { slug: 'claude-sonnet', label: 'Claude Sonnet' },
  ],
  copilot: [
    { slug: 'copilot-gpt', label: 'GPT (Copilot)' },
    { slug: 'copilot-claude', label: 'Claude (Copilot)' },
  ],
};

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const login = (name: string, uses: Partial<Pick<Login, 'chat' | 'coding' | 'primary' | 'state'>> = {}): Login => ({
  id: uuid(),
  login: name,
  state: 'active',
  chat: true,
  coding: true,
  primary: false,
  ...uses,
});
function plan(
  provider: Plan,
  index: number,
  chat: boolean,
  coding: boolean,
  state: State = 'connected',
  github?: Login,
) {
  const person = mockPeople[provider][index]!;
  return {
    connectionId: uuid(),
    provider,
    account: person.account,
    plan: person.plan!,
    state,
    chat,
    coding,
    githubAccountId: github?.id ?? null,
    createdAt: now(),
  } satisfies PlanAccount;
}

function scenario(name: string): Mock {
  const base = { attempts: {}, grants: {} };
  if (name === 'one') {
    const dev = login('dev-user', { primary: true });
    return {
      ...base,
      logins: [dev],
      plans: [plan('chatgpt', 0, true, true), plan('claude', 0, true, true)],
    };
  }
  if (name === 'many' || name === 'attention') {
    const lapsed: State = name === 'attention' ? 'reconnect-required' : 'connected';
    const dev = login('dev-user', { coding: false });
    const bot = login('acme-bot', { chat: false });
    const indexer = login('ada-indexer', {
      chat: false,
      coding: false,
      primary: true,
      state: name === 'attention' ? 'reconnect-required' : 'active',
    });
    return {
      ...base,
      logins: [dev, bot, indexer],
      plans: [
        plan('chatgpt', 0, true, false),
        plan('chatgpt', 1, false, true, lapsed),
        plan('claude', 0, true, false),
        plan('claude', 1, false, true, lapsed),
        plan('copilot', 0, true, false, 'connected', dev),
        plan('copilot', 1, false, true, lapsed, bot),
      ],
    };
  }
  return { ...base, logins: [], plans: [] };
}

if (import.meta.env.DEV && local && param === 'off') localStorage.removeItem(storageKey);
else if (import.meta.env.DEV && local && param) localStorage.setItem(storageKey, JSON.stringify(scenario(param)));
if (import.meta.env.DEV && local && param) {
  // Drop the param so return addresses built from this page don't reset the scenario.
  const clean = new URL(window.location.href);
  clean.searchParams.delete('planMock');
  history.replaceState(history.state, '', clean);
}

// Blocked storage throws here; the app must still start, just without the mock.
const stored = () => {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
};
export const planMockEnabled = import.meta.env.DEV && local && stored() !== null;

const read = (): Mock => JSON.parse(localStorage.getItem(storageKey) ?? 'null') ?? scenario('empty');
const write = (mock: Mock) => localStorage.setItem(storageKey, JSON.stringify(mock));

/** Completes a fake sign-in: adds the account, or renews the one being reconnected. Returns an error code on failure. */
export function finishMockSignIn(attemptId: string, index: number): string | null {
  const mock = read();
  const attempt = mock.attempts[attemptId];
  if (!attempt) return 'attempt-not-found';
  const person = mockPeople[attempt.provider][index]!;
  if (attempt.provider === 'github') {
    const existing = mock.logins.find(item => item.login === person.account);
    const account = existing ?? login(person.account, { primary: !mock.logins.some(item => item.primary) });
    if (existing) existing.state = 'active';
    else mock.logins.push(account);
    // Like the real sign-in, a login with a Copilot plan connects Copilot too.
    const copilot = mockPeople.copilot.findIndex(item => item.account === person.account && item.plan);
    if (copilot >= 0 && !mock.plans.some(item => item.provider === 'copilot' && item.githubAccountId === account.id)) {
      mock.plans.push(plan('copilot', copilot, true, true, 'connected', account));
    }
  } else if (!person.plan) {
    attempt.status = 'failed';
    attempt.error = 'not-eligible';
    write(mock);
    return 'not-eligible';
  } else {
    const renewing = mock.plans.find(item => item.connectionId === attempt.renew);
    const same = mock.plans.find(item => item.provider === attempt.provider && item.account === person.account);
    const target = renewing ?? same;
    if (target) Object.assign(target, { state: 'connected', account: person.account, plan: person.plan });
    else {
      mock.plans.push(plan(attempt.provider, index, true, true));
    }
  }
  attempt.status = 'completed';
  write(mock);
  return null;
}

export function readMockAttempt(attemptId: string) {
  return read().attempts[attemptId] ?? null;
}

/** The code the fake Claude page shows; pasting it back finishes that attempt as that account. */
export const mockClaudeCode = (attemptId: string, index: number) => `mock-claude-${index}-${attemptId}`;

if (planMockEnabled) {
  const originalFetch = window.fetch.bind(window);
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const fail = (code: string, status = 400) => json({ error: code }, status);
  const provider = `${window.location.origin}/mock-provider`;

  const connectionsOf = (mock: Mock, which: Plan) =>
    mock.plans
      .filter(item => item.provider === which)
      .map(item => ({
        connectionId: item.connectionId,
        state: item.state,
        ...(which === 'chatgpt'
          ? { email: item.account, welcomePending: false }
          : { account: item.account, githubAccountId: which === 'copilot' ? item.githubAccountId : undefined }),
        planUsage: true,
        models: models[which],
        createdAt: item.createdAt,
      }));
  const planList = (mock: Mock, which: Plan) =>
    which === 'chatgpt'
      ? { connections: connectionsOf(mock, which) }
      : { connections: connectionsOf(mock, which), deviceSignIn: which === 'copilot' };
  const githubList = (mock: Mock) => ({
    configured: true,
    installUrl: null,
    accounts: mock.logins.map(item => ({
      id: item.id,
      state: item.state,
      configured: true,
      identity: { id: String(parseInt(item.id.slice(0, 7), 16) + 1), login: item.login },
      generation: 1,
      scopes: ['repo', 'read:org', 'read:user'],
      useForChat: item.chat,
      useForCoding: item.coding,
      primaryForKnowledge: item.primary,
    })),
  });
  const begin = (mock: Mock, which: Attempt['provider'], renew: string | null) => {
    const attemptId = uuid();
    mock.attempts[attemptId] = { provider: which, renew, status: 'pending', error: null };
    write(mock);
    return { attemptId, url: `${provider}?provider=${which}&attempt=${attemptId}` };
  };

  let ownerId: Promise<string> | undefined;
  const ownMembership = (workspaceId: string) =>
    (ownerId ??= loadOwnMembership(workspaceId, new AbortController().signal).then(
      membership => membership.membershipId,
      () => '00000000-0000-4000-8000-000000000000',
    ));

  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    const path = url.pathname;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const match = path.match(/\/v1\/workspaces\/[^/]+\/(chatgpt|claude|copilot)\/connection(\/.*)?$/);
    const githubMatch = path.match(/\/v1\/workspaces\/[^/]+\/github\/accounts(\/.*)?$/);
    const subscriptions = path.match(/\/v1\/workspaces\/[^/]+\/subscriptions(\/.*)?$/);
    if (path.endsWith('/model-catalog') && method === 'GET') return withPlanFamilies(await originalFetch(input, init));
    if (!match && !githubMatch && !subscriptions) return originalFetch(input, init);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    await new Promise(resolve => setTimeout(resolve, 250));
    const mock = read();

    if (match) {
      const which = match[1] as Plan;
      const rest = match[2] ?? '';
      if (rest === '' && method === 'GET') return json(planList(mock, which));
      if (rest.startsWith('/attempts/')) {
        const attempt = mock.attempts[rest.slice('/attempts/'.length)];
        if (!attempt) return fail('attempt-not-found', 404);
        return json({ status: attempt.status, errorCode: attempt.error });
      }
      if (rest === '/begin') {
        const started = begin(mock, which, (body.connectionId as string | undefined) ?? null);
        return json(
          which === 'chatgpt'
            ? {
                attemptId: started.attemptId,
                authorizeUrl: started.url,
                redirectUri: 'http://localhost:1455/auth/callback',
                automatic: true,
                expiresInSeconds: 600,
              }
            : { attemptId: started.attemptId, authorizeUrl: started.url, expiresInSeconds: 600 },
        );
      }
      if (rest === '/device') {
        const started = begin(mock, which, (body.connectionId as string | undefined) ?? null);
        return json({
          attemptId: started.attemptId,
          userCode: 'MOCK-1234',
          verificationUri: started.url,
          intervalSeconds: 2,
          expiresInSeconds: 600,
        });
      }
      if (rest === '/complete') {
        const value = String(body.code ?? body.callbackUrl ?? '');
        const found = value.match(/mock-(?:claude|chatgpt)-(\d+)-([0-9a-f-]{36})/);
        if (!found) return fail(which === 'claude' ? 'code-invalid' : 'callback-invalid');
        const error = finishMockSignIn(found[2]!, Number(found[1]));
        return error ? fail(error) : json(planList(read(), which));
      }
      if (rest === '/token') {
        const token = String(body.token ?? '');
        const index = token.includes('bot') ? 1 : token.includes('free') ? 2 : 0;
        const started = begin(mock, which, (body.connectionId as string | undefined) ?? null);
        const error = finishMockSignIn(started.attemptId, index);
        return error ? fail(error) : json(planList(read(), which));
      }
      if (rest === '/github-account') {
        const github = mock.logins.find(item => item.id === body.accountId);
        if (!github) return fail('not-connected', 404);
        const index = mockPeople.copilot.findIndex(item => item.account === github.login);
        if (index < 0 || !mockPeople.copilot[index]!.plan) return fail('not-eligible');
        mock.plans.push(plan('copilot', index, true, true, 'connected', github));
        write(mock);
        return json(planList(mock, which));
      }
      const disconnect = rest.match(/^\/([^/]+)\/disconnect$/);
      if (disconnect) {
        mock.plans = mock.plans.filter(item => item.connectionId !== disconnect[1]);
        write(mock);
        return json({ revoked: true });
      }
      if (rest.endsWith('/welcome')) return json({});
    }

    if (githubMatch) {
      const rest = githubMatch[1] ?? '';
      if (rest === '' && method === 'GET') return json(githubList(mock));
      const started = (renew: string | null) => {
        const attempt = begin(mock, 'github', renew);
        const back = encodeURIComponent(window.location.pathname + window.location.search);
        return json({
          accountId: renew ?? uuid(),
          url: `https://github.com/login/oauth/authorize?tfMock=${encodeURIComponent(`${attempt.url}&back=${back}`)}`,
        });
      };
      if (rest === '/begin') return started(null);
      const reconnect = rest.match(/^\/([^/]+)\/reconnect$/);
      if (reconnect) return started(reconnect[1]!);
      const uses = rest.match(/^\/([^/]+)\/uses$/);
      if (uses) {
        const target = mock.logins.find(item => item.id === uses[1]);
        if (!target) return fail('account-not-found', 404);
        if (typeof body.chat === 'boolean') target.chat = body.chat;
        if (typeof body.coding === 'boolean') target.coding = body.coding;
        if (body.primaryForKnowledge) for (const item of mock.logins) item.primary = item === target;
        write(mock);
        return json(githubList(mock));
      }
      const disconnect = rest.match(/^\/([^/]+)\/disconnect$/);
      if (disconnect) {
        const account = githubList(mock).accounts.find(item => item.id === disconnect[1]);
        mock.logins = mock.logins.filter(item => item.id !== disconnect[1]);
        write(mock);
        return json({ account: { ...account, state: 'disconnected' }, providerRevocation: 'manual-required' });
      }
    }

    if (subscriptions) {
      const rest = subscriptions[1] ?? '';
      const owner = await ownMembership(path.split('/')[3] ?? '');
      if (rest === '' && method === 'GET')
        return json({
          subscriptions: mock.plans.map(item => ({
            connectionId: item.connectionId,
            provider: item.provider,
            ownerMembershipId: owner,
            account: item.account,
            state: item.state,
            mine: true,
            models: models[item.provider],
            disabledModels: [],
            canShare: true,
            grants: mock.grants[item.connectionId] ?? [],
            plan: item.plan,
            useForChat: item.chat,
            useForCoding: item.coding,
            createdAt: item.createdAt,
          })),
        });
      const uses = rest.match(/^\/([^/]+)\/uses$/);
      if (uses) {
        const target = mock.plans.find(item => item.connectionId === uses[1]);
        if (!target) return fail('not-connected', 404);
        if (typeof body.chat === 'boolean') target.chat = body.chat;
        if (typeof body.coding === 'boolean') target.coding = body.coding;
        write(mock);
        return json({});
      }
      const grants = rest.match(/^\/([^/]+)\/grants$/);
      if (grants) {
        mock.grants[grants[1]!] = (body.grants as unknown[]) ?? [];
        write(mock);
        return json({});
      }
      if (rest.endsWith('/models')) return json({});
    }
    return fail('plan-mock-route-not-implemented', 404);
  };
}

/** Adds one plan model per provider the member has a connected account on for chats, so the chat picker lists them. */
async function withPlanFamilies(response: Response) {
  if (!response.ok) return response;
  const catalog = (await response.json()) as { families: Record<string, unknown>[] };
  const base = catalog.families.find(family => family.available);
  const on = new Set(
    read()
      .plans.filter(item => item.state === 'connected' && item.chat)
      .map(item => item.provider),
  );
  const names: Record<Plan, string> = { claude: 'Claude Sonnet 5', chatgpt: 'GPT-5.5', copilot: 'GPT-5.5' };
  const added = base
    ? [...on].map(provider => ({
        ...base,
        id: `${provider}-mock-plan`,
        displayName: names[provider],
        provider,
        planUsage: { plan: 'own', status: 'available', limitedAt: null, premiumRequests: null },
      }))
    : [];
  return Response.json({ ...catalog, families: [...added, ...catalog.families] });
}

const providerNames = { chatgpt: 'ChatGPT', claude: 'Claude', copilot: 'GitHub Copilot', github: 'GitHub' } as const;

/** The fake sign-in page each mocked provider opens: pick an account, then get a code or go back. */
function renderProviderPage() {
  const search = new URLSearchParams(window.location.search);
  const which = search.get('provider') as keyof typeof providerNames | null;
  const attemptId = search.get('attempt') ?? '';
  const back = search.get('back');
  const page = document.createElement('div');
  page.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;background:#f6f6f4;color:#111;font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;overflow:auto';
  const card = document.createElement('div');
  card.style.cssText = 'width:min(440px,92vw);background:#fff;border:1px solid #ddd;border-radius:16px;padding:28px';
  page.append(card);
  const html = (value: string) => {
    card.innerHTML = value;
  };
  const button = (label: string, sub: string, onClick: () => void) => {
    const item = document.createElement('button');
    item.style.cssText =
      'display:block;width:100%;text-align:left;margin-top:10px;padding:12px 14px;border:1px solid #ddd;border-radius:10px;background:#fff;cursor:pointer;font:inherit';
    item.innerHTML = `<strong>${label}</strong><br><span style="color:#666;font-size:13px">${sub}</span>`;
    item.onclick = onClick;
    card.append(item);
  };
  const attempt = which ? readMockAttempt(attemptId) : null;
  if (!which || !attempt) {
    html('<h1 style="font-size:20px;margin:0">Mock sign-in not found</h1><p>Start again from TulipFarm.</p>');
  } else {
    const name = providerNames[which];
    html(
      `<p style="margin:0;color:#666;font-size:13px">MOCK ${name.toUpperCase()} · nothing here is real</p>` +
        `<h1 style="font-size:22px;margin:6px 0 4px">${which === 'copilot' ? 'Enter code MOCK-1234' : `Sign in to ${name}`}</h1>` +
        `<p style="margin:0 0 6px;color:#444">Pick the account to connect to TulipFarm.</p>`,
    );
    mockPeople[which].forEach((person, index) =>
      button(person.account, person.plan ?? 'No paid plan, so the connection will fail', () => {
        if (which === 'claude') {
          const code = mockClaudeCode(attemptId, index);
          html(
            `<h1 style="font-size:20px;margin:0 0 8px">Paste this code into TulipFarm</h1>` +
              `<code style="display:block;padding:12px;background:#f1f1ef;border-radius:8px;word-break:break-all">${code}</code>` +
              `<p style="color:#666;font-size:13px">Copied. Return to the TulipFarm tab and select Finish sign-in.</p>`,
          );
          void navigator.clipboard?.writeText(code).catch(() => undefined);
          return;
        }
        const error = finishMockSignIn(attemptId, index);
        if (which === 'github' && back) {
          window.location.assign(back);
          return;
        }
        html(
          error
            ? `<h1 style="font-size:20px;margin:0">${person.account} has no ${name} plan</h1><p>TulipFarm shows the error. Close this tab.</p>`
            : `<h1 style="font-size:20px;margin:0">Connected ${person.account}</h1><p>Return to TulipFarm; it updates in a moment. You can close this tab.</p>` +
                (which === 'chatgpt'
                  ? `<p style="color:#666;font-size:13px">If it doesn’t, paste this address into TulipFarm:</p><code style="display:block;padding:12px;background:#f1f1ef;border-radius:8px;word-break:break-all">http://localhost:1455/auth/callback?code=mock-chatgpt-${index}-${attemptId}</code>`
                  : ''),
        );
      }),
    );
  }
  const mount = () => document.body.append(page);
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
}

if (planMockEnabled && window.location.pathname === '/mock-provider') renderProviderPage();
