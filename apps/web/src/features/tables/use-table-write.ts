import { useEffect, useRef, useState } from 'react';
import { failedWrite, type WriteState } from './request-state';

export function useTableWrite<T, R>(send: (input: T) => Promise<R>, accepted: (result: R) => void) {
  const [state, setState] = useState<WriteState<T>>({ kind: 'idle' });
  const sending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function submit(input: T): Promise<boolean> {
    if (sending.current) return false;
    sending.current = true;
    setState({ kind: 'sending', input });
    try {
      const result = await send(input);
      if (mounted.current) {
        setState({ kind: 'accepted' });
        accepted(result);
      }
      return true;
    } catch (error) {
      if (mounted.current) setState(failedWrite(input, error));
      return false;
    } finally {
      sending.current = false;
    }
  }
  return { state, submit, reset: () => setState({ kind: 'idle' }) };
}
