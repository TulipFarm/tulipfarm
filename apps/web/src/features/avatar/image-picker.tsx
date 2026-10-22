import { useRef, useState } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { EntityAvatar } from '@tulipfarm/sprout/avatar';
import { AvatarImageError, shrinkAvatar } from '@/lib/avatar-image';

export function AvatarImagePicker({
  seed,
  name,
  image,
  shape,
  disabled,
  onChange,
}: {
  seed: string;
  name: string;
  image: string | null;
  shape: 'circle' | 'square';
  disabled?: boolean;
  onChange: (image: string | null) => void;
}) {
  const chooser = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState('');
  async function choose(file: File | undefined) {
    if (!file) return;
    setProblem('');
    try {
      onChange(await shrinkAvatar(file));
    } catch (error) {
      setProblem(
        error instanceof AvatarImageError ? error.message : 'This image could not be used. Choose another one.',
      );
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <EntityAvatar seed={seed} name={name} image={image} size="lg" shape={shape} />
      <Input
        ref={chooser}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        tabIndex={-1}
        aria-hidden
        onChange={event => {
          void choose(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => chooser.current?.click()}>
        {image ? 'Change image' : 'Upload image'}
      </Button>
      {image && (
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => {
            setProblem('');
            onChange(null);
          }}
        >
          Remove
        </Button>
      )}
      {problem && (
        <p role="alert" className="basis-full text-sm text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
