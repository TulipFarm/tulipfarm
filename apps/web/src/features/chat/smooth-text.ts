import { useEffect, useRef, useState } from 'react';

// Previews arrive in bursts at least 200 ms apart. The base speed lets the reveal finish soon after the last burst,
// before the saved answer replaces the preview; the backlog term keeps it from falling behind fast models.
const catchUpMs = 400;
const minCharsPerMs = 0.2;

/** Moves `length` forward to the end of the word it lands in, so markdown never renders half a word or token. */
export function revealPoint(text: string, length: number) {
  if (length >= text.length) return text.length;
  const space = text.slice(length).search(/\s/);
  return space < 0 ? text.length : length + space;
}

function commonPrefix(a: string, b: string) {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index++;
  return index;
}

/** Characters revealed after `elapsedMs` more milliseconds, starting from `position`. */
export function advance(length: number, position: number, elapsedMs: number) {
  // A frame's timestamp can precede the effect's start, and a background tab resumes after a long pause.
  const elapsed = Math.min(Math.max(elapsedMs, 0), 100);
  const speed = Math.max(minCharsPerMs, (length - position) / catchUpMs);
  return Math.min(length, position + speed * elapsed);
}

/** Reveals streamed text word by word, speeding up as more text is waiting. */
export function useSmoothText(text: string, enabled = true) {
  const [reduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const animate = enabled && !reduced;
  const [length, setLength] = useState(0);
  const position = useRef(0);
  const previous = useRef('');
  useEffect(() => {
    if (!animate) return;
    // A rewritten preview restarts from the part both versions share.
    position.current = Math.min(position.current, commonPrefix(previous.current, text));
    previous.current = text;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      position.current = advance(text.length, position.current, now - last);
      last = now;
      setLength(revealPoint(text, Math.floor(position.current)));
      if (position.current < text.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [animate, text]);
  return animate ? text.slice(0, length) : text;
}
