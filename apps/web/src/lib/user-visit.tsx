import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { apiOrigin } from './auth';
import { jsonResponse, readJson, requestSignal } from './http';

const visitSchema = z.object({ firstSession: z.boolean() });
const FirstSession = createContext<boolean | null>(null);

export function UserVisitProvider({
  identity,
  children,
}: {
  identity: { userId: string; sessionId: string } | null;
  children: ReactNode;
}) {
  const key = identity ? JSON.stringify([identity.userId, identity.sessionId]) : null;
  const [visit, setVisit] = useState<{ key: string; firstSession: boolean } | null>(null);
  useEffect(() => {
    if (!key) return;
    const sessionKey = key;
    const controller = new AbortController();
    async function recordVisit() {
      try {
        const response = await jsonResponse(`${apiOrigin}/v1/user/visit`, {
          method: 'POST',
          signal: requestSignal(controller.signal),
        });
        if (!response.ok) return;
        const result = visitSchema.parse(await readJson(response));
        if (!controller.signal.aborted) setVisit({ key: sessionKey, firstSession: result.firstSession });
      } catch {
        /* The application remains usable without a personalized greeting. */
      }
    }
    void recordVisit();
    return () => controller.abort();
  }, [key]);
  return <FirstSession value={visit?.key === key ? (visit?.firstSession ?? null) : null}>{children}</FirstSession>;
}

export function useFirstSession() {
  return useContext(FirstSession);
}
