// X counts posts with its published twitter-text v3 configuration
// (https://github.com/twitter/twitter-text/blob/master/config/v3.json and
// https://docs.x.com/fundamentals/counting-characters): text is NFC-normalized,
// each link counts as 23, each emoji (including ZWJ and modifier sequences) as 2,
// code points in the ranges below as 1, and every other code point as 2.
export const xTextWeights = {
  scale: 100,
  defaultWeight: 200,
  transformedUrlLength: 23,
  ranges: [
    { start: 0, end: 4351, weight: 100 },
    { start: 8192, end: 8205, weight: 100 },
    { start: 8208, end: 8223, weight: 100 },
    { start: 8242, end: 8247, weight: 100 },
  ],
} as const;

export const xTextLimits = { standard: 280, premium: 25000 } as const;

// twitter-text recognises bare domains against a TLD list. This matches any
// dotted host with an alphabetic TLD instead, so a token such as `notes.txt`
// counts as a link here; that can only make the count stricter than X's.
const link =
  /(?:https?:\/\/|www\.)[^\s]+|(?<![\p{L}\p{N}@._-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[a-z]{2,63}(?:\/[^\s]*)?(?![\p{L}\p{N}@_-])/giu;
const trailing = /[.,;:!?'")\]]+$/u;
const emoji = new RegExp('^\\p{RGI_Emoji}$', 'v');
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

function codePointWeight(codePoint: number) {
  for (const range of xTextWeights.ranges) if (codePoint >= range.start && codePoint <= range.end) return range.weight;
  return xTextWeights.defaultWeight;
}

function plainWeight(text: string) {
  let weight = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (emoji.test(segment)) {
      weight += xTextWeights.defaultWeight;
      continue;
    }
    for (const character of segment) weight += codePointWeight(character.codePointAt(0)!);
  }
  return weight;
}

/** The weighted length X applies to `text`, in characters. */
export function xWeightedLength(text: string): number {
  const normalized = text.normalize('NFC');
  let weight = 0;
  let index = 0;
  for (const match of normalized.matchAll(link)) {
    const url = match[0].replace(trailing, '');
    weight += plainWeight(normalized.slice(index, match.index));
    weight += xTextWeights.transformedUrlLength * xTextWeights.scale;
    index = match.index + url.length;
  }
  weight += plainWeight(normalized.slice(index));
  return weight / xTextWeights.scale;
}
