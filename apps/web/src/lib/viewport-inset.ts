import { useLayoutEffect, type RefObject } from 'react';

export function useViewportInset(
  ref: RefObject<HTMLElement | null>,
  property: `--${string}`,
  { enabled = true, gap = 0 } = {},
) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const root = document.documentElement;
    let previous = '';
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
      const value = `${visible ? Math.ceil(rect.height) + gap : 0}px`;
      if (value === previous) return;
      previous = value;
      root.style.setProperty(property, value);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty(property);
    };
  }, [ref, property, enabled, gap]);
}
