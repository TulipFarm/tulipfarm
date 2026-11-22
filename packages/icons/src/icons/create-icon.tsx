import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import type { ReactElement, Ref, SVGProps } from 'react';

/** Named icon sizes in pixels. Change one here to resize every icon that uses it. */
export const iconSizes = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
} as const;

export type IconSize = keyof typeof iconSizes;

/** Stroke width shared by every icon. */
export const iconStrokeWidth = 1.5;

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'ref'> & {
  size?: IconSize | number;
  ref?: Ref<SVGSVGElement>;
};

export type IconComponent = (props: IconProps) => ReactElement;

export function createIcon(glyph: IconSvgElement, name: string): IconComponent {
  const Icon = ({ size = '2xl', strokeWidth = iconStrokeWidth, ...props }: IconProps) => (
    <HugeiconsIcon
      icon={glyph}
      size={typeof size === 'number' ? size : iconSizes[size]}
      strokeWidth={Number(strokeWidth)}
      {...props}
    />
  );
  Icon.displayName = name;
  return Icon;
}
