import type { ComponentType } from 'react';
import { BrandIcon, BrandTile } from '@tulipfarm/sprout/brand-icon';
import { Cpu } from 'reicon-react/icons/Cpu';
import { modelBrand, type ModelBrand } from './model-brand';

type LogoSize = 'inline' | 'sm';
export type ModelLogoComponent = ComponentType<{ size?: number; 'aria-hidden'?: boolean | 'true' }>;

function BrandLogo({ brand, size }: { brand: ModelBrand | null; size: LogoSize }) {
  if (brand) return <BrandIcon brand={brand} size={size} />;
  const glyph = <Cpu size={16} aria-hidden="true" />;
  return size === 'inline' ? (
    <span
      data-slot="brand-icon"
      data-brand="neutral"
      className="grid size-4 shrink-0 place-items-center text-muted-foreground"
    >
      {glyph}
    </span>
  ) : (
    <BrandTile data-brand="neutral" size="sm">
      <span className="grid place-items-center text-muted-foreground">{glyph}</span>
    </BrandTile>
  );
}

/** A family's vendor logo, or a neutral chip for vendors without one (operator catalogs, OpenAI-compatible servers). */
export function ModelLogo({ vendor, size = 'inline' }: { vendor: string | undefined; size?: LogoSize }) {
  return <BrandLogo brand={modelBrand(vendor)} size={size} />;
}

const logos = new Map<ModelBrand | null, ModelLogoComponent>();

/** A stable logo component per brand, for pickers that take an icon component. */
export function modelLogo(vendor: string | undefined): ModelLogoComponent {
  const brand = modelBrand(vendor);
  let Logo = logos.get(brand);
  if (!Logo) {
    Logo = () => <BrandLogo brand={brand} size="inline" />;
    Logo.displayName = `ModelLogo(${brand ?? 'neutral'})`;
    logos.set(brand, Logo);
  }
  return Logo;
}
