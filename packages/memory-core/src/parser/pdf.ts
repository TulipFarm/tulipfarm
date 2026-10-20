import { decodePDFRawStream, PDFArray, PDFDict, PDFName, PDFRawStream } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import { KnowledgeParseError, parserLimits } from './contracts.js';

type Token = { kind: 'name' | 'word'; value: string } | { kind: 'value' };

export function checkPdf(document: PDFDocument): void {
  const form = document.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (form?.has(PDFName.of('XFA')) || (form?.lookupMaybe(PDFName.of('Fields'), PDFArray)?.size() ?? 0) > 0) {
    throw new KnowledgeParseError('unsupported');
  }
  let hasAnnotations = false;
  let expandedBytes = 0;
  const active = new Set<PDFRawStream>();
  function inspectForm(object: PDFRawStream, resources: PDFDict | undefined): void {
    if (object.dict.lookup(PDFName.of('Subtype'), PDFName).decodeText() !== 'Form')
      throw new KnowledgeParseError('unsupported');
    if (active.has(object) || active.size >= 64) malformed();
    active.add(object);
    inspect([object], object.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resources);
    active.delete(object);
  }
  function inspect(streams: PDFRawStream[], resources: PDFDict | undefined): void {
    const contents = streams
      .map(stream => {
        const bytes = decodePDFRawStream(stream).decode();
        expandedBytes += bytes.length;
        if (expandedBytes > parserLimits.expandedBytes) throw new KnowledgeParseError('resource-limited');
        return Buffer.from(bytes).toString('latin1');
      })
      .join('\n');
    let previous: Token | undefined;
    for (const token of tokens(contents)) {
      if (token.kind === 'word') {
        if (token.value === 'BI') throw new KnowledgeParseError('ocr-required');
        if (token.value === 'Do') {
          if (previous?.kind !== 'name') malformed();
          const objects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
          const object = objects?.lookup(PDFName.of(previous.value));
          if (!(object instanceof PDFRawStream)) malformed();
          const subtype = object.dict.lookup(PDFName.of('Subtype'), PDFName).decodeText();
          if (subtype === 'Image') throw new KnowledgeParseError('ocr-required');
          inspectForm(object, resources);
        }
        if (token.value === 'gs') {
          if (previous?.kind !== 'name') malformed();
          const states = resources?.lookupMaybe(PDFName.of('ExtGState'), PDFDict);
          const state = states?.lookup(PDFName.of(previous.value));
          if (!(state instanceof PDFDict)) malformed();
          const mask = state.lookup(PDFName.of('SMask'));
          // Soft-mask rendering is not represented in native text extraction.
          if (mask && !(mask instanceof PDFName && mask.decodeText() === 'None'))
            throw new KnowledgeParseError('ocr-required');
        }
        // Pattern paints can contain images in their own content streams.
        if ((token.value === 'scn' || token.value === 'SCN') && previous?.kind === 'name')
          throw new KnowledgeParseError('unsupported');
        previous = undefined;
      } else previous = token;
    }
  }
  for (const page of document.getPages()) {
    const contents = page.node.Contents();
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map(value => document.context.lookup(value))
        : contents
          ? [contents]
          : [];
    inspect(
      streams.map(stream => {
        if (!(stream instanceof PDFRawStream)) malformed();
        return stream;
      }),
      page.node.Resources(),
    );
    const annotations = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    for (const reference of annotations?.asArray() ?? []) {
      hasAnnotations = true;
      const annotation = document.context.lookup(reference, PDFDict);
      const appearances = annotation.lookupMaybe(PDFName.of('AP'), PDFDict);
      for (const name of ['N', 'R', 'D']) {
        const appearance = appearances?.lookup(PDFName.of(name));
        if (!appearance) continue;
        const streams =
          appearance instanceof PDFDict
            ? appearance.values().map(value => document.context.lookup(value))
            : [appearance];
        for (const stream of streams) {
          if (!(stream instanceof PDFRawStream)) malformed();
          inspectForm(stream, page.node.Resources());
        }
      }
    }
  }
  if (hasAnnotations) throw new KnowledgeParseError('unsupported');
}

function* tokens(text: string): Generator<Token> {
  let position = 0;
  const stack: string[] = [];
  const whitespace = (character: string) => [0, 9, 10, 12, 13, 32].includes(character.charCodeAt(0));
  const delimiter = (character: string) => whitespace(character) || '()<>[]{}/%'.includes(character);
  while (position < text.length) {
    const character = text[position++] ?? '';
    if (whitespace(character)) continue;
    if (character === '%') {
      while (position < text.length && !['\r', '\n'].includes(text[position] ?? '')) position += 1;
      continue;
    }
    if (character === '(') {
      let depth = 1;
      while (position < text.length && depth) {
        const next = text[position++];
        if (next === '\\') position += 1;
        else if (next === '(') depth += 1;
        else if (next === ')') depth -= 1;
      }
      if (depth) malformed();
      if (!stack.length) yield { kind: 'value' };
      continue;
    }
    if (character === '<' && text[position] !== '<') {
      while (position < text.length && text[position] !== '>') {
        const next = text[position++] ?? '';
        if (!whitespace(next) && !/[0-9a-fA-F]/.test(next)) malformed();
      }
      if (text[position++] !== '>') malformed();
      if (!stack.length) yield { kind: 'value' };
      continue;
    }
    if (character === '[' || character === '<') {
      if (character === '<') position += 1;
      stack.push(character === '[' ? ']' : '>');
      if (stack.length > 256) throw new KnowledgeParseError('resource-limited');
      continue;
    }
    if (character === ']' || character === '>') {
      if (stack.pop() !== character) malformed();
      if (character === '>' && text[position++] !== '>') malformed();
      if (!stack.length) yield { kind: 'value' };
      continue;
    }
    if (character === ')' || character === '{' || character === '}') malformed();
    const start = character === '/' ? position : position - 1;
    while (position < text.length && !delimiter(text[position] ?? '')) position += 1;
    if (stack.length) continue;
    const value = text.slice(start, position);
    if (character === '/') {
      yield {
        kind: 'name',
        value: value.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))),
      };
    } else if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || ['true', 'false', 'null'].includes(value))
      yield { kind: 'value' };
    else yield { kind: 'word', value };
  }
  if (stack.length) malformed();
}

function malformed(): never {
  throw new KnowledgeParseError('malformed');
}
