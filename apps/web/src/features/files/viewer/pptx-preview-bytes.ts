import JSZip from 'jszip';

export async function pptxPreviewBytes(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const archive = await JSZip.loadAsync(bytes);
  const entry = archive.file('[Content_Types].xml');
  if (!entry) return bytes.slice(0);
  const contentTypes = new DOMParser().parseFromString(await entry.async('string'), 'application/xml');
  if (contentTypes.querySelector('parsererror')) return bytes.slice(0);
  const missing = new Set<string>();
  for (const declaration of Array.from(contentTypes.getElementsByTagNameNS('*', 'Override'))) {
    const part = declaration.getAttribute('PartName');
    if (part?.startsWith('/') && !archive.file(part.slice(1))) {
      declaration.remove();
      missing.add(part);
    }
  }
  if (!missing.size) return bytes.slice(0);
  for (const relationshipPart of archive.file(/\.rels$/)) {
    const relationships = new DOMParser().parseFromString(await relationshipPart.async('string'), 'application/xml');
    const directory = relationshipPart.name.replace(/(?:^|\/)_rels\/[^/]+$/, '/');
    for (const relationship of Array.from(relationships.getElementsByTagNameNS('*', 'Relationship'))) {
      const target = relationship.getAttribute('Target');
      if (!target || relationship.getAttribute('TargetMode') === 'External') continue;
      const path = new URL(target, `https://pptx.invalid/${directory.replace(/^\//, '')}`).pathname;
      if (missing.has(decodeURIComponent(path))) throw new Error('A required presentation part is missing');
    }
  }
  // pptx-preview silently stops at stale declarations of absent parts. Only the preview copy is repaired.
  archive.file('[Content_Types].xml', new XMLSerializer().serializeToString(contentTypes));
  return archive.generateAsync({ type: 'arraybuffer' });
}
