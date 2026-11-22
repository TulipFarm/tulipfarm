import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { QueryClient, queryOptions, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiOrigin } from '@/lib/auth';

const optionsSchema = z.object({
  turnstileSiteKey: z.string().trim().min(1).nullable(),
  // Email and password sign-in (password in AUTH_METHODS), and whether reset links go out by email.
  emailPassword: z.boolean().default(false),
  passwordResetEmail: z.boolean().default(false),
  // Sign-in methods the server has credentials for; hidden unless the API reports them.
  google: z.boolean().default(false),
  magicLink: z.boolean().default(false),
});
const PublicQueryContext = createContext<QueryClient | null>(null);

declare global {
  interface Window {
    /** The sign-in options request the HTML starts on sign-in paths (vite.config.ts earlyRequests). */
    __tfAuthOptions?: { url: string; response: Promise<Response>; data?: unknown };
  }
}

/** Which sign-in methods the login page index.html paints before the app loads should show. */
function rememberMethods({ emailPassword, google, magicLink }: z.infer<typeof optionsSchema>) {
  try {
    localStorage.setItem('tulipfarm:auth-methods', JSON.stringify({ emailPassword, google, magicLink }));
  } catch {
    // Storage can be full or blocked; the early page then shows its default methods.
  }
}

/** The early request, once and only for the same URL: later fetches, such as a retry, go to the network. */
function takeEarlyOptions(url: string) {
  const early = globalThis.window?.__tfAuthOptions;
  delete globalThis.window?.__tfAuthOptions;
  if (!early || early.url !== new URL(url, location.href).href) return undefined;
  return early.response.catch(() => undefined);
}

export function PublicAuthQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => {
    const created = new QueryClient();
    // Options that already arrived seed the query, so the form doesn't grow when they land.
    const early = globalThis.window?.__tfAuthOptions;
    const parsed = optionsSchema.safeParse(early?.data);
    if (early?.url === new URL(`${apiOrigin}/v1/auth/options`, location.href).href && parsed.success) {
      delete globalThis.window?.__tfAuthOptions;
      created.setQueryData(authOptionsQuery().queryKey, parsed.data);
      rememberMethods(parsed.data);
    }
    return created;
  });
  useEffect(() => {
    client.mount();
    return () => client.unmount();
  }, [client]);
  return <PublicQueryContext.Provider value={client}>{children}</PublicQueryContext.Provider>;
}

export function authOptionsQuery() {
  return queryOptions({
    queryKey: ['public', 'auth', 'options'],
    staleTime: 15 * 60_000,
    gcTime: 30 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    networkMode: 'always',
    queryFn: async ({ signal }) => {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      const url = `${apiOrigin}/v1/auth/options`;
      const early = await takeEarlyOptions(url);
      const response =
        early ??
        (await fetch(url, {
          signal: deadline,
          credentials: 'omit',
          cache: 'no-store',
        }));
      if (!response.ok) throw new Error('Options unavailable');
      const options = optionsSchema.parse(await response.json());
      deadline.throwIfAborted();
      rememberMethods(options);
      return options;
    },
  });
}

export function useAuthOptions() {
  const client = useContext(PublicQueryContext);
  if (!client) throw new Error('Public auth query provider required');
  return useQuery(authOptionsQuery(), client);
}
