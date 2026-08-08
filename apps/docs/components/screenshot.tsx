"use client";

import { ImageZoom } from "fumadocs-ui/components/image-zoom";

/**
 * A product screenshot with a caption. Framed with the site's hairline border rather than a
 * shadow, and click-to-zoom so a dense screen stays readable inside the docs measure.
 *
 * `src` is a path under `public/`, so it survives the static export untouched. Image
 * optimisation is off globally in `next.config.mjs` — required for `output: "export"`.
 */
export function Screenshot({
  src,
  alt,
  caption,
  width = 2560,
  height = 1440,
}: {
  src: string;
  alt: string;
  caption?: string;
  width?: number;
  height?: number;
}) {
  return (
    <figure className="not-prose my-6 overflow-hidden rounded-lg border border-fd-border bg-fd-card">
      <ImageZoom src={src} alt={alt} width={width} height={height} className="m-0 block w-full" />
      {caption ? (
        <figcaption className="border-t border-fd-border px-4 py-2.5 text-xs leading-5 text-fd-muted-foreground">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}
