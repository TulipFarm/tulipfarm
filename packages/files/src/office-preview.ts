import { documentFormat } from "./document-preview";

export interface PreviewTableSpan {
  readonly row: number;
  readonly column: number;
  readonly rowSpan: number;
  readonly colSpan: number;
}

/** Safe shared display shapes; CSV and document projections both use these grids. */
export type PreviewBlock =
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | {
      readonly kind: "listItem";
      readonly text: string;
      readonly depth?: number;
      readonly ordered?: boolean;
      readonly marker?: string;
    }
  | {
      readonly kind: "table";
      readonly rows: readonly (readonly string[])[];
      readonly headerRows?: number;
      readonly spans?: readonly PreviewTableSpan[];
    }
  | { readonly kind: "sheet"; readonly name: string; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: "slide"; readonly title: string; readonly bullets: readonly string[] };

export const MAX_PREVIEW_BLOCKS = 400;
export const MAX_PREVIEW_ROWS = 200;
export const MAX_PREVIEW_COLUMNS = 256;

export function isOfficePreviewable(mediaType: string): boolean {
  return documentFormat(mediaType) !== null;
}
