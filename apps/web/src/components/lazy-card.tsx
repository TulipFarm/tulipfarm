import {
  createElement,
  lazy,
  Suspense,
  useEffect,
  useReducer,
  useState,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from 'react';

const Unavailable = () => null;

/**
 * A component loaded on first render, so pages that never show it do not download it. A card that cannot download,
 * such as while offline, shows nothing instead of failing its page, and loads again once the browser is back online.
 * `preload` downloads it ahead of time, so a card first shown later appears at once instead of after a blank frame.
 * `fallback` shows instead of nothing while it downloads or when it cannot, such as a wrapper's plain text.
 */
// The cast keeps generic components (tables, read states) generic for their callers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyCard<C extends ComponentType<any>>(
  load: () => Promise<C>,
  fallback?: (props: ComponentProps<C>) => ReactNode,
): C & { preload: () => Promise<void> } {
  let loaded: C | undefined;
  const loader = () =>
    lazy<ComponentType<ComponentProps<C>>>(async () => {
      try {
        loaded = await load();
        return { default: loaded as ComponentType<ComponentProps<C>> };
      } catch {
        Card = loader();
        return { default: (fallback ?? Unavailable) as ComponentType<ComponentProps<C>> };
      }
    });
  let Card = loader();
  function LazyCard(props: ComponentProps<C>) {
    const [, retry] = useReducer((attempt: number) => attempt + 1, 0);
    // Chosen once per card, so a card never remounts when its download finishes elsewhere.
    const [ready] = useState(() => loaded);
    useEffect(() => {
      window.addEventListener('online', retry);
      return () => window.removeEventListener('online', retry);
    }, []);
    // Forwards every prop unchanged; it adds no appearance of its own.
    if (ready) return createElement(ready, props);
    return <Suspense fallback={fallback?.(props) ?? null}>{createElement(Card, props)}</Suspense>;
  }
  LazyCard.preload = () =>
    load().then(
      component => void (loaded ??= component),
      () => {},
    );
  return LazyCard as unknown as C & { preload: () => Promise<void> };
}
