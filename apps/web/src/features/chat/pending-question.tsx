import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

const PendingQuestionsContext = createContext<{ pending: boolean; register: () => () => void } | null>(null);

export function PendingQuestionsProvider({ children }: { children: ReactNode }) {
  const [requests, setRequests] = useState<Set<symbol>>(() => new Set());
  const register = useCallback(() => {
    const key = Symbol();
    setRequests(current => new Set(current).add(key));
    return () =>
      setRequests(current => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
  }, []);
  return <PendingQuestionsContext value={{ pending: requests.size > 0, register }}>{children}</PendingQuestionsContext>;
}

export function usePendingQuestion() {
  return useContext(PendingQuestionsContext)?.pending ?? false;
}
export function useRegisterPendingQuestion(active: boolean) {
  const register = useContext(PendingQuestionsContext)?.register;
  useEffect(() => (active ? register?.() : undefined), [active, register]);
}
