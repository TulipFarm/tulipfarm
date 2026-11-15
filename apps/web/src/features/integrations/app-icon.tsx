import { useState, type CSSProperties } from 'react';
import { Plug } from 'reicon-react/icons/Plug';
import { BrandIcon, BrandTile, type Brand } from '@tulipfarm/sprout/brand-icon';

type Size = 'md' | 'lg' | 'xl' | 'row';
const tileShape: Record<Size, string> = {
  md: 'rounded-lg',
  lg: 'rounded-xl text-lg',
  xl: 'rounded-2xl text-2xl',
  row: 'rounded-xl text-lg',
};
const logoSize: Record<Size, string> = { md: 'size-4', lg: 'size-6', xl: 'size-8', row: 'size-6' };
const plugSize: Record<Size, number> = { md: 16, lg: 20, xl: 24, row: 20 };

/**
 * An app's logo. Apps without a Sprout glyph get their catalog logo in white on their brand colour, or the first
 * letter when there's no logo or it doesn't load. Unknown servers get a plug.
 */
export function AppIcon({
  brand,
  tile,
  logo,
  size = 'md',
}: {
  brand?: Brand | undefined;
  tile?: { letter: string; color: string } | undefined;
  logo?: string | undefined;
  size?: Size;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (brand) return <BrandIcon brand={brand} size={size} />;
  if (tile)
    return (
      <span className="flex shrink-0" style={{ '--app-tile': tile.color } as CSSProperties}>
        <BrandTile size={size} aria-hidden="true">
          <span
            className={`flex size-full items-center justify-center bg-(--app-tile) font-semibold text-white ${tileShape[size]}`}
          >
            {logo && failed !== logo ? (
              <img
                src={logo}
                alt=""
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                onError={() => setFailed(logo)}
                className={`brightness-0 invert ${logoSize[size]}`}
              />
            ) : (
              tile.letter
            )}
          </span>
        </BrandTile>
      </span>
    );
  return (
    <BrandTile size={size} aria-hidden="true">
      <Plug size={plugSize[size]} />
    </BrandTile>
  );
}
