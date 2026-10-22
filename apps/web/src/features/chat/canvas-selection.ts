import type { CanvasItem } from './canvas-state';

export type CanvasSelection = {
  items: CanvasItem[];
  activeId: string | null;
  open: boolean;
};

export type CanvasAction =
  | { type: 'show'; item: CanvasItem }
  | { type: 'update'; id: string; patch: Partial<Omit<CanvasItem, 'id'>> }
  | { type: 'select'; id: string }
  | { type: 'close'; id: string }
  | { type: 'visibility'; open: boolean };

export const emptyCanvas: CanvasSelection = { items: [], activeId: null, open: false };

export function canvasSelection(state: CanvasSelection, action: CanvasAction): CanvasSelection {
  switch (action.type) {
    case 'show':
      return {
        items: state.items.some(item => item.id === action.item.id)
          ? state.items.map(item => (item.id === action.item.id ? action.item : item))
          : [...state.items, action.item],
        activeId: action.item.id,
        open: true,
      };
    case 'update':
      return state.items.some(item => item.id === action.id)
        ? { ...state, items: state.items.map(item => (item.id === action.id ? { ...item, ...action.patch } : item)) }
        : state;
    case 'select':
      return state.items.some(item => item.id === action.id) ? { ...state, activeId: action.id } : state;
    case 'close': {
      const index = state.items.findIndex(item => item.id === action.id);
      if (index < 0) return state;
      const items = state.items.filter(item => item.id !== action.id);
      return {
        items,
        activeId:
          state.activeId === action.id ? (items[Math.min(index, items.length - 1)]?.id ?? null) : state.activeId,
        open: state.open && items.length > 0,
      };
    }
    case 'visibility':
      return { ...state, open: action.open && state.items.length > 0 };
  }
}
