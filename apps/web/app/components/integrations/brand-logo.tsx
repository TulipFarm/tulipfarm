/*
 * Full-colour brand marks, vendored.
 *
 * The API resolves a manifest `icon` slug against Simple Icons, which ships one *monochrome* path
 * per brand and has dropped some marks entirely — Slack among them. That is fine for a brand whose
 * logo is monochrome anyway (GitHub, Linear), but for one whose colour *is* the identity it renders
 * as a generic silhouette. Those are authored here and take precedence; everything else falls
 * through to the Simple Icons glyph in the brand's own hex.
 *
 * Vendored rather than fetched: an instance runs on the operator's own infrastructure, so a logo
 * CDN would break offline installs and leak which integrations an instance browses.
 */

export type BrandLogo = {
  /** Each mark keeps the viewBox it was authored in. */
  readonly viewBox: string;
  readonly paths: readonly { readonly fill: string; readonly d: string }[];
};

const SLACK: BrandLogo = {
  viewBox: "0 0 127 127",
  paths: [
    {
      fill: "#E01E5A",
      d: "M27.2 80a13.2 13.2 0 0 1-13.2 13.2A13.2 13.2 0 0 1 .8 80a13.2 13.2 0 0 1 13.2-13.2h13.2Zm6.6 0a13.2 13.2 0 0 1 13.2-13.2A13.2 13.2 0 0 1 60.2 80v33a13.2 13.2 0 0 1-13.2 13.2A13.2 13.2 0 0 1 33.8 113Z",
    },
    {
      fill: "#36C5F0",
      d: "M47 27a13.2 13.2 0 0 1-13.2-13.2A13.2 13.2 0 0 1 47 .6a13.2 13.2 0 0 1 13.2 13.2V27Zm0 6.7a13.2 13.2 0 0 1 13.2 13.2A13.2 13.2 0 0 1 47 60.1H13.9A13.2 13.2 0 0 1 .7 46.9a13.2 13.2 0 0 1 13.2-13.2Z",
    },
    {
      fill: "#2EB67D",
      d: "M99.9 46.9a13.2 13.2 0 0 1 13.2-13.2 13.2 13.2 0 0 1 13.2 13.2 13.2 13.2 0 0 1-13.2 13.2H99.9Zm-6.6 0a13.2 13.2 0 0 1-13.2 13.2 13.2 13.2 0 0 1-13.2-13.2V13.8A13.2 13.2 0 0 1 80.1.6a13.2 13.2 0 0 1 13.2 13.2Z",
    },
    {
      fill: "#ECB22E",
      d: "M80.1 99.8a13.2 13.2 0 0 1 13.2 13.2 13.2 13.2 0 0 1-13.2 13.2A13.2 13.2 0 0 1 66.9 113V99.8Zm0-6.6a13.2 13.2 0 0 1-13.2-13.2 13.2 13.2 0 0 1 13.2-13.2h33.1a13.2 13.2 0 0 1 13.2 13.2 13.2 13.2 0 0 1-13.2 13.2Z",
    },
  ],
};

const GOOGLE: BrandLogo = {
  viewBox: "0 0 48 48",
  paths: [
    {
      fill: "#FFC107",
      d: "M43.6 20.1H42V20H24v8h11.3A12 12 0 1 1 24 12c3.1 0 5.8 1.2 8 3l5.7-5.6A20 20 0 1 0 44 24c0-1.3-.1-2.6-.4-3.9Z",
    },
    {
      fill: "#FF3D00",
      d: "m6.3 14.7 6.6 4.8A12 12 0 0 1 24 12c3.1 0 5.8 1.2 8 3l5.7-5.6A20 20 0 0 0 6.3 14.7Z",
    },
    {
      fill: "#4CAF50",
      d: "M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2A12 12 0 0 1 12.7 28l-6.5 5A20 20 0 0 0 24 44Z",
    },
    {
      fill: "#1976D2",
      d: "M43.6 20.1H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9Z",
    },
  ],
};

/* Keyed by the manifest `icon` slug the API forwards. Aliases cover the product names a manifest
   may legitimately use for the same mark. */
const LOGOS: Record<string, BrandLogo> = {
  slack: SLACK,
  google: GOOGLE,
  googleworkspace: GOOGLE,
  googledrive: GOOGLE,
  gmail: GOOGLE,
};

/** A vendored full-colour mark for this slug, or null to fall back to the Simple Icons glyph. */
export function brandLogo(slug: string | undefined | null): BrandLogo | null {
  if (!slug) return null;
  return LOGOS[slug.toLowerCase()] ?? null;
}
