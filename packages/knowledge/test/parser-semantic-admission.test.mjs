import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toMarkdownBytes } from '@firecrawl/anydoc/index.js';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { KnowledgeParseError, parseKnowledgeDocument } from '../dist/parser.js';
import { annotationPdf } from './fixtures/parser-completeness.mjs';
import { odt, officeParts, zip } from './fixtures/parser-documents.mjs';
import { formPdf } from '../../conversations/test/knowledge-extraction-admission-fixtures.mjs';

const parse = (bytes, extension) =>
  parseKnowledgeDocument({ bytes, filename: `qualification.${extension}`, mediaType: 'application/octet-stream' });
const unsupported = error => error instanceof KnowledgeParseError && error.code === 'unsupported';

export const qualifiedRtf = [
  [String.raw`{\rtf1\ansi Balance -450}`, 'Balance -450\n'],
  [String.raw`{\rtf1\ansi Limit {\strike 450} 500}`, 'Limit ~~450~~ 500\n'],
  [String.raw`{\rtf1\ansi Limit \strike 450\strike0 500}`, 'Limit ~~450~~500\n'],
  [String.raw`{\rtf1\ansi Limit {\b {\strike 450}} 500}`, 'Limit ~~**450**~~ 500\n'],
  [String.raw`{\rtf1\ansi Limit\tab 450}`, 'Limit 450\n'],
  [String.raw`{\rtf1\ansi\uc1 Balance \u8722?450}`, 'Balance −450\n'],
  [String.raw`{\rtf1\ansi\uc1 Caf\u233?}`, 'Café\n'],
  [String.raw`{\rtf1\ansi {\b Bold} {\i Italic}}`, '**Bold** *Italic*\n'],
  [String.raw`{\rtf1\ansi A\line B\par C}`, 'A\\\nB\n\nC\n'],
  [String.raw`{\rtf1\ansi Literal \\super 450}`, 'Literal \\\\super 450\n'],
  [String.raw`{\rtf1\ansi Literal \'5csuper 450}`, 'Literal \\\\super 450\n'],
  [
    String.raw`{\rtf1\ansi\deff0{\fonttbl{\f0\fnil\fcharset0 Arial;}}{\colortbl;\red255\green0\blue0;}\f0 Balance -450}`,
    'Balance -450\n',
  ],
];

for (const [source, expected] of qualifiedRtf) {
  test(`qualified RTF preserves literal output ${source}`, async () => {
    const bytes = Buffer.from(source);
    assert.equal(await toMarkdownBytes(bytes), expected);
    assert.equal((await parse(bytes, 'rtf')).markdown, expected);
  });
}

for (const control of [
  'v',
  'v0',
  'super',
  'sub',
  'up6',
  'dn6',
  'ul',
  'revised',
  'deleted',
  'caps',
  'scaps',
  'rtlch',
  'field',
  'pict',
  'object',
  'supermarket',
  'Super',
  'futuresemantic',
]) {
  test(`RTF rejects unqualified control ${control}`, async () => {
    await assert.rejects(parse(Buffer.from(`{\\rtf1\\ansi Limit {\\${control} 450} 500}`), 'rtf'), unsupported);
  });
}

for (const source of [
  String.raw`{\rtf1\ansi\uc1 {\upr{Balance 450}{\*\ud Balance \u8722?450}}}`,
  String.raw`{\rtf1\ansi {\*\unknown Budget 450}500}`,
  String.raw`{\rtf1\ansi {\fonttbl{\f0\fnil Symbol;}}\f0 Balance -450}`,
  String.raw`{\rtf1\ansi {\fonttbl{\f0\fnil Arial;\v 450}}Balance 500}`,
  String.raw`{\rtf1\ansi {\colortbl;\red255\green0\blue0;\v 450}Balance 500}`,
  String.raw`{\rtf1\ansi\uc0 Balance \u8722 450}`,
  String.raw`{\rtf1\ansi\uc1 Balance \u8722\'3f450}`,
  String.raw`{\rtf1\ansi\uc1 \u-10179?\u-8704?}`,
]) {
  test(`RTF rejects unqualified destination or encoding ${source}`, async () => {
    await assert.rejects(parse(Buffer.from(source), 'rtf'), unsupported);
  });
}

async function annotatedPdf(subtype, appearance = true) {
  const document = await PDFDocument.load(await annotationPdf(''));
  const page = document.getPage(0);
  const annotation = document.context.lookup(page.node.lookup(PDFName.of('Annots')).get(0));
  annotation.set(PDFName.of('Subtype'), PDFName.of(subtype));
  annotation.set(PDFName.of('Contents'), PDFString.of('Maximum is 450'));
  if (appearance)
    annotation.set(
      PDFName.of('AP'),
      document.context.obj({
        N: document.context.register(
          document.context.flateStream('BT /F1 12 Tf 72 650 Td (Maximum is 450) Tj ET', {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 612, 792],
            Resources: page.node.Resources(),
          }),
        ),
      }),
    );
  else annotation.delete(PDFName.of('AP'));
  return document;
}

for (const subtype of ['Text', 'FreeText', 'Stamp', 'Link', 'Widget']) {
  for (const appearance of [true, false]) {
    test(`PDF rejects ${subtype} annotation with ${appearance ? 'distinct appearance' : 'no appearance'}`, async () => {
      const bytes = await (await annotatedPdf(subtype, appearance)).save();
      if (appearance && subtype !== 'Widget')
        assert.equal(await toMarkdownBytes(bytes), 'Native heading and explanatory budget policy text\n');
      await assert.rejects(parse(bytes, 'pdf'), unsupported);
    });
  }
}

test('PDF rejects widgets and catalog fields even without page annotations', async () => {
  const bytes = await formPdf();
  await assert.rejects(parse(bytes, 'pdf'), unsupported);
  const document = await PDFDocument.load(bytes);
  for (const page of document.getPages()) page.node.delete(PDFName.of('Annots'));
  await assert.rejects(parse(await document.save(), 'pdf'), unsupported);
});

test('PDF retains ordinary page text and invoked text Form facts', async () => {
  const document = await annotatedPdf('Stamp');
  const page = document.getPage(0);
  const annotation = document.context.lookup(page.node.lookup(PDFName.of('Annots')).get(0));
  const appearance = annotation.lookup(PDFName.of('AP')).get(PDFName.of('N'));
  page.node.Resources().set(PDFName.of('XObject'), document.context.obj({ Fact: appearance }));
  page.node.addContentStream(document.context.register(document.context.flateStream('/Fact Do')));
  page.node.delete(PDFName.of('Annots'));
  assert.equal(
    (await parse(await document.save(), 'pdf')).markdown,
    'Native heading and explanatory budget policy text\n\n## Maximum is 450\n',
  );
});

export function semanticOdt(content, properties = '', extra = []) {
  const xml = `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.2"><office:automatic-styles><style:style style:name="Marked" style:family="text"><style:text-properties ${properties}/></style:style></office:automatic-styles><office:body><office:text>${content}</office:text></office:body></office:document-content>`;
  return zip([...officeParts(odt()).map(([path, body]) => [path, path === 'content.xml' ? xml : body]), ...extra]);
}

export const qualifiedOdt = [
  [
    '<text:h text:outline-level="1">Orchard policy</text:h><text:p>Harvest apples on Tuesday.</text:p>',
    '',
    '# Orchard policy\n\nHarvest apples on Tuesday.\n',
  ],
  [
    '<text:p>Limit <text:span text:style-name="Marked">450</text:span> 500</text:p>',
    'style:text-line-through-style="solid" style:text-line-through-type="single"',
    'Limit ~~450~~ 500\n',
  ],
  [
    '<text:p><text:span text:style-name="Marked">Maximum 450</text:span></text:p>',
    'fo:font-weight="bold" fo:font-style="italic"',
    '***Maximum 450***\n',
  ],
  [
    '<text:p>Budget <office:annotation><text:p>Maximum is 450</text:p></office:annotation></text:p>',
    '',
    'Budget Maximum is 450\n',
  ],
];

for (const [body, properties, expected] of qualifiedOdt) {
  test(`ODT qualified content preserves facts ${body} ${properties}`, async () => {
    const bytes = semanticOdt(body, properties);
    assert.equal(await toMarkdownBytes(bytes), expected);
    assert.equal((await parse(bytes, 'odt')).markdown, expected);
  });
}

for (const property of [
  'style:text-position="super 58%"',
  'style:text-position="sub 58%"',
  'style:text-position="25% 80%"',
  'style:text-line-through-style="wave"',
  'style:text-line-through-text="X"',
  'fo:text-transform="uppercase"',
  'text:display="none"',
  'fo:font-variant="small-caps"',
  'style:unknown-semantic-property="450"',
]) {
  test(`ODT rejects unqualified semantic style ${property}`, async () => {
    await assert.rejects(
      parse(
        semanticOdt(
          '<text:p>Area 10<text:span text:style-name="Marked">2</text:span> square metres</text:p>',
          property,
        ),
        'odt',
      ),
      unsupported,
    );
  });
}

for (const body of [
  '<text:p>Budget</text:p><office:annotation><text:p>Maximum is 450</text:p></office:annotation>',
  '<text:tracked-changes><text:changed-region text:id="change"><text:deletion><text:p>Limit 450</text:p></text:deletion></text:changed-region></text:tracked-changes><text:p>Limit 500</text:p>',
  '<text:p>Limit <text:change-start text:change-id="change"/>500<text:change-end text:change-id="change"/></text:p>',
  '<text:p>Limit <text:hidden-text text:condition="true">450</text:hidden-text>500</text:p>',
  '<text:p>Area <text:span text:unknown="superscript">102</text:span></text:p>',
  '<text:p>Limit <text:unknown>450</text:unknown>500</text:p>',
  '<text:p><style:text-properties>Maximum 450</style:text-properties></text:p>',
  '<text:p><text:span text:style-name="Missing">Maximum 450</text:span></text:p>',
]) {
  test(`ODT rejects unqualified structure ${body}`, async () => {
    await assert.rejects(parse(semanticOdt(body), 'odt'), unsupported);
  });
}

test('ODT rejects unqualified external style parts rather than flattening their properties', async () => {
  await assert.rejects(
    parse(
      semanticOdt('<text:p>Maximum 450</text:p>', '', [
        ['styles.xml', '<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>'],
      ]),
      'odt',
    ),
    unsupported,
  );
});
