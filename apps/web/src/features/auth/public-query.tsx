import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { QueryClient, queryOptions, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiOrigin } from '@/lib/auth';

const optionsSchema = z.object({
  turnstileSiteKey: z.string().trim().min(1).nullable(),
  // Self-hosted email and password sign-in (AUTH_EMAIL_PASSWORD), and whether reset links go out by email.
  emailPassword: z.boolean().default(false),
  passwordResetEmail: z.boolean().default(false),
});
const PublicQueryContext = createContext<QueryClient | null>(null);

export function PublicAuthQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient());
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
      const response = await fetch(`${apiOrigin}/v1/auth/options`, {
        signal: deadline,
        credentials: 'omit',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('Options unavailable');
      const options = optionsSchema.parse(await response.json());
      deadline.throwIfAborted();
      return options;
    },
  });
}

export function useAuthOptions() {
  const client = useContext(PublicQueryContext);
  if (!client) throw new Error('Public auth query provider required');
  return useQuery(authOptionsQuery(), client);
}
