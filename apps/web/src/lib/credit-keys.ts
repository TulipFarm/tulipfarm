// Query keys a credits web extension reads; app changes that spend credits invalidate them.
export const creditKeys = {
  balance: () => ['credits', 'balance'] as const,
};
