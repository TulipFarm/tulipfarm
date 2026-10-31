import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { InputGroupAddon } from '@tulipfarm/sprout/input-group';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@tulipfarm/sprout/combobox';

type Glyphs = Readonly<Record<string, string>>;
/** Custom emoji image URLs by short name. */
export type CustomEmoji = ReadonlyMap<string, string>;

let glyphs: Glyphs | undefined;
let pending: Promise<Glyphs> | undefined;

/** Standard emoji characters, loaded on first use. */
export function useEmojiGlyphs() {
  const [loaded, setLoaded] = useState(glyphs);
  useEffect(() => {
    if (loaded) return;
    let active = true;
    pending ??= import('virtual:emoji-glyphs').then(module => (glyphs = module.default));
    void pending.then(value => {
      if (active) setLoaded(value);
    });
    return () => {
      active = false;
    };
  }, [loaded]);
  return loaded;
}

export function SlackEmoji({
  name,
  glyphs,
  custom,
}: {
  name: string;
  glyphs: Glyphs | undefined;
  custom: CustomEmoji;
}) {
  const url = custom.get(name);
  if (url)
    return <img src={url} alt="" width={20} height={20} className="inline-block size-5 shrink-0 object-contain" />;
  const glyph = glyphs?.[name] ?? glyphs?.[name.split('::')[0] ?? ''];
  return glyph ? (
    <span className="shrink-0">{glyph}</span>
  ) : (
    <span className="shrink-0 font-mono text-xs text-muted-foreground">:{name}:</span>
  );
}

export function SlackEmojiPicker({
  id,
  value,
  taken,
  glyphs,
  custom,
  onValueChange,
  onKeyDown,
}: {
  id: string;
  value: string;
  /** Names other rules already use. */
  taken: readonly string[];
  glyphs: Glyphs | undefined;
  custom: CustomEmoji;
  onValueChange: (name: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const items = useMemo(() => {
    const names = new Set([...custom.keys(), ...Object.keys(glyphs ?? {}).filter(name => !name.includes('::'))]);
    for (const name of taken) names.delete(name);
    names.add(value);
    return [...names];
  }, [custom, glyphs, taken, value]);
  return (
    <Combobox<string>
      items={items}
      autoHighlight
      limit={50}
      value={value}
      itemToStringLabel={name => `:${name}:`}
      onValueChange={name => {
        if (name) onValueChange(name);
      }}
    >
      <ComboboxInput id={id} placeholder="Search emoji" onKeyDown={onKeyDown}>
        <InputGroupAddon align="inline-start" aria-hidden="true">
          <SlackEmoji name={value} glyphs={glyphs} custom={custom} />
        </InputGroupAddon>
      </ComboboxInput>
      <ComboboxContent>
        <ComboboxEmpty>No emoji match.</ComboboxEmpty>
        <ComboboxList>
          {(name: string) => (
            <ComboboxItem key={name} value={name}>
              <SlackEmoji name={name} glyphs={glyphs} custom={custom} />
              <span className="truncate">:{name}:</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
