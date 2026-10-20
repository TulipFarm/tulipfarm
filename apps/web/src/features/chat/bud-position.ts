import { useEffect, useState } from 'react';

export const budPositionKey = 'tulipfarm:bud-corner';
export const budCorners = {
  'bottom-right': 'Bottom right',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'top-left': 'Top left',
};
export type BudCorner = keyof typeof budCorners;
export const budCornerClasses: Record<BudCorner, string> = {
  'bottom-right': 'right-4 bottom-4 items-end',
  'top-right': 'right-4 top-4 flex-col-reverse items-end',
  'bottom-left': 'left-4 bottom-4 items-start',
  'top-left': 'left-4 top-4 flex-col-reverse items-start',
};
export function isBudCorner(value: unknown): value is BudCorner {
  return typeof value === 'string' && Object.hasOwn(budCorners, value);
}
export function nearestBudCorner(x: number, y: number, width: number, height: number): BudCorner {
  return `${y < height / 2 ? 'top' : 'bottom'}-${x < width / 2 ? 'left' : 'right'}`;
}
function decode(value: string | null): { corner: BudCorner; error: string | null } {
  if (value === null || isBudCorner(value)) return { corner: value ?? 'bottom-right', error: null };
  return {
    corner: 'bottom-right',
    error: 'Saved Bud position is invalid. Drag Bud or save its current position again.',
  };
}
export function useBudPosition() {
  const [state, setState] = useState<{ corner: BudCorner; error: string | null }>(() => {
    try {
      return decode(localStorage.getItem(budPositionKey));
    } catch {
      return { corner: 'bottom-right', error: "This browser could not load Bud's position." };
    }
  });
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === budPositionKey || event.key === null) setState(decode(event.newValue));
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  const move = (corner: BudCorner) => {
    try {
      localStorage.setItem(budPositionKey, corner);
      setState({ corner, error: null });
    } catch {
      setState({ corner, error: 'Bud moved for this visit, but this browser could not save its position.' });
    }
  };
  return { ...state, move };
}
