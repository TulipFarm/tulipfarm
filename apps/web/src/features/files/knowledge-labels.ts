interface Gaps {
  count: number;
  items: { kind: string }[];
}

/** "3 images couldn’t be read." for a document whose latest version has parts Knowledge could not read. */
export function knowledgeGapSummary(gaps: Gaps | null | undefined) {
  if (!gaps?.count) return null;
  const images = gaps.items.every(item => item.kind === 'image');
  const noun = images ? (gaps.count === 1 ? 'image' : 'images') : gaps.count === 1 ? 'part' : 'parts';
  return `${gaps.count} ${noun} couldn’t be read.`;
}

/** "slide 4" from the API reads as "Slide 4" next to the source name. */
export function knowledgePlaceLabel(location: string | undefined) {
  return location ? `${location.charAt(0).toUpperCase()}${location.slice(1)}` : '';
}
