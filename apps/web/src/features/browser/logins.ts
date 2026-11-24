import { useMemo } from 'react';
import { z } from 'zod';
import { browserSessionStateSchema } from '@tulipfarm/browser/contracts';
import { browserLoginSummarySchema, type BrowserLoginSummary } from '@tulipfarm/browser/login-contracts';
import type { SecretGrant } from '@/features/secrets/contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import { TableRequestError } from '@/features/tables/request-state';

export type { BrowserLoginSummary };

const messages: Record<string, string> = {
  'invalid-request': 'Check the name and site, then try again. The site must have signed-in data to save.',
  'browser-login-not-found': 'This login is no longer available to you.',
  'browser-login-unavailable':
    'This login can’t be used or copied right now. Its owner may have left, or it belongs to someone else.',
  'browser-login-too-large': 'This site keeps too much data to save as a login.',
  'browser-logins-unavailable': 'Logins aren’t available right now. Try again later.',
  'browser-not-found': 'This browser has closed. Ask the agent to open it again.',
  'browser-unavailable': 'The browser isn’t reachable right now. Try again in a moment.',
};

export function browserLoginErrorMessage(error: unknown) {
  return error instanceof TableRequestError ? error.message : 'Couldn’t confirm the outcome. Check your connection.';
}

const listSchema = z.object({ enabled: z.boolean(), logins: z.array(browserLoginSummarySchema) });
const stateSchema = z.object({ browser: browserSessionStateSchema });

/** Saved browser logins: listing, managing, and saving or loading them in a chat's browser. */
export function browserLoginsApi(workspaceId: string) {
  const workspace = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}`;
  const base = `${workspace}/browser-logins`;
  const chat = (chatId: string) => `${workspace}/conversations/${encodeURIComponent(chatId)}/browser/logins`;
  async function request(url: string, signal: AbortSignal, method = 'GET', body?: unknown) {
    const response = await jsonResponse(url, { method, cache: 'no-store', signal, body });
    const value = await readJson(response, true);
    if (!response.ok) {
      const code = responseError(value, 'browser-logins-unavailable');
      throw new TableRequestError(response.status, code, messages[code] ?? messages['browser-logins-unavailable']!);
    }
    return value;
  }
  const login = (id: string) => `${base}/${encodeURIComponent(id)}`;
  const timeout = () => AbortSignal.timeout(15_000);
  return {
    list: async (signal: AbortSignal, site?: string) =>
      listSchema.parse(await request(site ? `${base}?site=${encodeURIComponent(site)}` : base, signal)),
    rename: async (id: string, name: string) =>
      browserLoginSummarySchema.parse(await request(login(id), timeout(), 'PATCH', { name })),
    share: async (id: string, grants: SecretGrant[]) =>
      browserLoginSummarySchema.parse(await request(`${login(id)}/grants`, timeout(), 'PUT', { grants })),
    remove: async (id: string) => {
      await request(login(id), timeout(), 'DELETE');
    },
    save: async (chatId: string, input: { name: string; site: string }) =>
      browserLoginSummarySchema.parse(await request(chat(chatId), AbortSignal.timeout(30_000), 'POST', input)),
    load: async (chatId: string, id: string) =>
      stateSchema.parse(
        await request(`${chat(chatId)}/${encodeURIComponent(id)}/load`, AbortSignal.timeout(30_000), 'POST'),
      ).browser,
  };
}

export const browserLoginKeys = {
  all: ['browser-logins'] as const,
  list: (site?: string) => ['browser-logins', 'list', site ?? ''] as const,
};

export function useBrowserLoginsApi(workspaceId: string) {
  return useMemo(() => browserLoginsApi(workspaceId), [workspaceId]);
}

export function useBrowserLogins(workspaceId: string, site?: string, enabled = true) {
  const api = useBrowserLoginsApi(workspaceId);
  return useFeatureRead({ key: browserLoginKeys.list(site), load: signal => api.list(signal, site), enabled });
}

export function useBrowserLoginChanges() {
  const { change } = useFeatureChanges();
  return useMemo(() => ({ changed: () => change({ keys: [browserLoginKeys.all] }) }), [change]);
}

/** A login's site from a page address: its host without `www.`, or empty for pages that aren't on a website. */
export function siteOfPage(url: string) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? hostname.toLowerCase().replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}
