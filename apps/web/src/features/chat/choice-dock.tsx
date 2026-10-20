import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

const ChoiceDockContext = createContext<{
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
} | null>(null);
const PendingQuestionsContext = createContext<{ pending: boolean; register: () => () => void } | null>(null);

export function ChoiceDockProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
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
  return (
    <PendingQuestionsContext value={{ pending: requests.size > 0, register }}>
      <ChoiceDockContext value={{ target, setTarget }}>{children}</ChoiceDockContext>
    </PendingQuestionsContext>
  );
}

export function useChoiceDock() {
  return useContext(ChoiceDockContext)?.target;
}
export function usePendingQuestion() {
  return useContext(PendingQuestionsContext)?.pending ?? false;
}
export function useRegisterPendingQuestion(active: boolean) {
  const register = useContext(PendingQuestionsContext)?.register;
  useEffect(() => (active ? register?.() : undefined), [active, register]);
}

export function ChoiceDock() {
  const dock = useContext(ChoiceDockContext);
  return (
    <div
      ref={dock?.setTarget}
      role="region"
      aria-label="Questions"
      className="max-h-96 space-y-3 overflow-y-auto empty:hidden"
    />
  );
}
