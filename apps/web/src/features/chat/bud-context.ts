import { createContext, useContext } from 'react';
import type { z } from 'zod';
import type { BudState, budCommandSchema } from '@tulipfarm/conversations/bud-contracts';

export type BudCommand = z.infer<typeof budCommandSchema>;
export const BudContext = createContext<{
  state: BudState | null;
  busy: boolean;
  error: string | null;
  command: (command: BudCommand) => Promise<BudState | null>;
  refresh: () => void;
  returnFromSetup: () => void;
  mainHost: (element: HTMLDivElement | null) => void;
} | null>(null);
export const useBud = () => useContext(BudContext);
