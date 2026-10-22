import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import type {
  AvatarOptions,
  TulipAvatarCharacter,
  TulipAvatarColor,
  TulipAvatarSize,
  TulipAvatarState,
  TulipAvatarView,
} from './tulip-avatar/catalog';
import type { AvatarHandle } from './tulip-avatar/runtime';

export { tulipAvatarCharacters, tulipAvatarColors, tulipAvatarStates } from './tulip-avatar/catalog';
export type {
  TulipAvatarCharacter,
  TulipAvatarColor,
  TulipAvatarSize,
  TulipAvatarState,
  TulipAvatarView,
} from './tulip-avatar/catalog';

export interface TulipAvatarProps {
  name?: string;
  character?: TulipAvatarCharacter;
  color?: TulipAvatarColor;
  state?: TulipAvatarState;
  size?: TulipAvatarSize;
  shape?: 'circle' | 'square';
  variant?: 'default' | 'plain';
  view?: TulipAvatarView;
  paused?: boolean;
  onReady?: () => void;
  onError?: (error: Error) => void;
}

const sizes = {
  24: 'size-6',
  32: 'size-8',
  40: 'size-10',
  64: 'size-16',
  128: 'size-32',
  256: 'size-64',
} satisfies Record<TulipAvatarSize, string>;

export function TulipAvatar({
  name,
  character = 'Bud',
  color = 'Blue',
  state = 'Idle',
  size = 40,
  shape = 'circle',
  variant = 'default',
  view = 'head',
  paused = false,
  onReady,
  onError,
}: TulipAvatarProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const handle = useRef<AvatarHandle | null>(null);
  const options = useRef<AvatarOptions>({ character, color, state, view, paused });
  const errorCallback = useRef(onError);
  const readyCallback = useRef(onReady);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const label = name?.trim() || character;

  useEffect(() => {
    errorCallback.current = onError;
    readyCallback.current = onReady;
  }, [onError, onReady]);

  useEffect(() => {
    if (status === 'ready') readyCallback.current?.();
  }, [status]);

  useEffect(() => {
    options.current = { character, color, state, view, paused };
    handle.current?.update(options.current);
  }, [character, color, state, view, paused]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let disposed = false;
    setStatus('loading');
    const fail = (error: Error) => {
      if (disposed) return;
      console.error('Tulip avatar rendering failed', error);
      setStatus('error');
      errorCallback.current?.(error);
    };
    void import('./tulip-avatar/runtime')
      .then(({ mountAvatar }) => {
        if (disposed) return;
        handle.current = mountAvatar(
          element,
          options.current,
          () => {
            if (!disposed) setStatus('ready');
          },
          fail,
        );
      })
      .catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
    return () => {
      disposed = true;
      handle.current?.dispose();
      handle.current = null;
    };
  }, [attempt]);

  return (
    <span
      data-slot="tulip-avatar"
      data-character={character}
      data-state={state}
      data-status={status}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden align-middle text-xs text-muted-foreground',
        variant === 'default' && 'bg-muted',
        sizes[size],
        shape === 'circle' ? 'rounded-full' : 'rounded-lg',
      )}
    >
      <canvas
        ref={canvas}
        role="img"
        aria-label={`${label}, ${state.toLowerCase()}${status === 'loading' ? ', loading avatar' : ''}`}
        aria-busy={status === 'loading'}
        aria-hidden={status === 'error'}
        className={cn('size-full touch-pan-y', status !== 'ready' && 'invisible')}
      />
      {status === 'loading' && (
        <span aria-hidden="true" className="absolute">
          {label.charAt(0).toUpperCase()}
        </span>
      )}
      {status === 'error' && (
        <button
          type="button"
          className="absolute inset-0 flex items-center justify-center focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          aria-label={`${label} avatar unavailable. Retry avatar`}
          title="Could not show the 3D avatar. Enable hardware acceleration, then retry."
          onClick={() => setAttempt(value => value + 1)}
        >
          {label.charAt(0).toUpperCase()}
        </button>
      )}
    </span>
  );
}
