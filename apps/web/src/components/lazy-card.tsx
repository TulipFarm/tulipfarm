import { createElement, lazy, Suspense, useEffect, useReducer, type ComponentProps, type ComponentType } from 'react';

const Unavailable = () => null;

/**
 * A component loaded on first render, so pages that never show it do not download it. A card that cannot download,
 * such as while offline, shows nothing instead of failing its page, and loads again once the browser is back online.
 */
// The cast keeps generic components (tables, read states) generic for their callers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyCard<C extends ComponentType<any>>(load: () => Promise<C>): C {
  const loader = () =>
    lazy<ComponentType<ComponentProps<C>>>(async () => {
      try {
        return { default: (await load()) as ComponentType<ComponentProps<C>> };
      } catch {
        Card = loader();
        return { default: Unavailable as ComponentType<ComponentProps<C>> };
      }
    });
  let Card = loader();
  function LazyCard(props: ComponentProps<C>) {
    const [, retry] = useReducer((attempt: number) => attempt + 1, 0);
    useEffect(() => {
      window.addEventListener('online', retry);
      return () => window.removeEventListener('online', retry);
    }, []);
    // Forwards every prop unchanged; it adds no appearance of its own.
    return <Suspense fallback={null}>{createElement(Card, props)}</Suspense>;
  }
  return LazyCard as unknown as C;
}
