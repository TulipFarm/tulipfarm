import { createElement, lazy, Suspense, type ComponentProps, type ComponentType } from 'react';

/** A component loaded on first render, so pages that never show it do not download it. */
// The cast keeps generic components (tables, read states) generic for their callers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyCard<C extends ComponentType<any>>(load: () => Promise<C>): C {
  const Card = lazy(async () => ({ default: await load() }));
  function LazyCard(props: ComponentProps<C>) {
    // Forwards every prop unchanged; it adds no appearance of its own.
    return <Suspense fallback={null}>{createElement(Card, props)}</Suspense>;
  }
  return LazyCard as unknown as C;
}
