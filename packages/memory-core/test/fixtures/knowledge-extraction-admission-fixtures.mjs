import JSZip from 'jszip';
import { docx, note, paragraph, relationship, relationships, textStream } from './knowledge-extraction-fixtures.mjs';

export const numbering = [
  'word/numbering.xml',
  '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="450"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>',
];
const numberingContentType =
  '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>';
const numberedParagraph = text =>
  `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;

export const numberedList = () =>
  docx(
    numberedParagraph('Pay supplier') + numberedParagraph('Send receipt'),
    [numbering, relationships([relationship('numbering', 'numbering.xml')])],
    numberingContentType,
  );

export const checkbox = checked =>
  docx(
    `<w:p><w:r><w:t>Approved:</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:name w:val="Approval"/><w:enabled/><w:checkBox><w:sizeAuto/><w:default w:val="0"/><w:checked w:val="${checked}"/></w:checkBox></w:ffData></w:fldChar></w:r><w:r><w:instrText xml:space="preserve"> FORMCHECKBOX </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
  );

export const comments = () =>
  docx(
    '<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Budget</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>',
    [
      relationships([relationship('comments', 'comments.xml')]),
      [
        'word/comments.xml',
        `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="Reviewer">${paragraph('Maximum is 450')}</w:comment></w:comments>`,
      ],
    ],
    '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>',
  );

export const drawingTextBox = () =>
  docx(
    `${paragraph('Budget')}<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="1000000" cy="1000000"/><wp:docPr id="1" name="Business facts"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr><wps:txbx><w:txbxContent>${paragraph('Maximum is 450')}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
  );

export function formPdf() {
  const stream = textStream('Budget');
  const appearance = 'BT /F1 12 Tf 2 10 Td (450) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] /DA (/F1 12 Tf 0 g) /DR << /Font << /F1 4 0 R >> >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (BudgetLimit) /V (450) /Rect [72 680 200 710] /P 3 0 R /F 4 /DA (/F1 12 Tf 0 g) /AP << /N 7 0 R >> >>',
    `<< /Type /XObject /Subtype /Form /BBox [0 0 128 30] /Resources << /Font << /F1 4 0 R >> >> /Length ${appearance.length} >>\nstream\n${appearance}\nendstream`,
  ];
  let output = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output);
}

export async function rewriteDocx(bytes, entries = [], compression = 'STORE') {
  const archive = await JSZip.loadAsync(bytes, { createFolders: false });
  for (const [path, transform] of entries) {
    const value = typeof transform === 'function' ? transform(await archive.file(path).async('string')) : transform;
    archive.file(path, value, { createFolders: false });
  }
  return archive.generateAsync({ type: 'nodebuffer', compression });
}

export function strictAdmissionFixtures() {
  const budget = paragraph('Budget');
  const replaceDocument = transform => rewriteDocx(docx(budget), [['word/document.xml', transform]]);
  const fixtures = [
    ['unknown empty WordML element', docx(`${budget}<w:unknown/>`)],
    ['unknown WordML element with a fact', docx(`${budget}<w:unknown>450</w:unknown>`)],
    ['text in paragraph properties', docx('<w:p><w:pPr><w:t>450</w:t></w:pPr><w:r><w:t>Budget</w:t></w:r></w:p>')],
    ['text in section properties', docx(`${budget}<w:sectPr><w:t>450</w:t></w:sectPr>`)],
    ['text in run properties', docx('<w:p><w:r><w:rPr><w:t>450</w:t></w:rPr><w:t>Budget</w:t></w:r></w:p>')],
    ['unknown WordML attribute', docx('<w:p w:unknown="450"><w:r><w:t>Budget</w:t></w:r></w:p>')],
    [
      'struck out amount',
      docx(
        '<w:p><w:r><w:t>Limit </w:t></w:r><w:r><w:rPr><w:strike/></w:rPr><w:t>450</w:t></w:r><w:r><w:t> 500</w:t></w:r></w:p>',
      ),
    ],
    [
      'superscript exponent',
      docx(
        '<w:p><w:r><w:t>Area 10</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>2</w:t></w:r><w:r><w:t> square metres</w:t></w:r></w:p>',
      ),
    ],
    [
      'empty hyperlink label',
      docx(`${budget}<w:p><w:hyperlink r:id="hyperlink"><w:r><w:t/></w:r></w:hyperlink></w:p>`, [
        relationships([relationship('hyperlink', 'https://example.com/450', 'TargetMode="External"')]),
      ]),
    ],
    ['unknown unqualified attribute', docx('<w:p unknown="450"><w:r><w:t>Budget</w:t></w:r></w:p>')],
    ['unknown attribute in known namespace', docx('<w:p><w:r><w:t xml:unknown="450">Budget</w:t></w:r></w:p>')],
    ['unreferenced unknown package part', docx(budget, [['word/business-facts.xml', '<facts>Maximum is 450</facts>']])],
    [
      'unknown package content type',
      docx(budget, [], '<Default Extension="facts" ContentType="application/x-business-facts"/>'),
    ],
    [
      'unknown document relationship type',
      docx(budget, [relationships([relationship('businessFacts', 'document.xml')])]),
    ],
    [
      'unknown root package relationship type',
      docx(budget, [['_rels/.rels', relationships([relationship('businessFacts', 'word/document.xml')])[1]]]),
    ],
    ['malformed mismatched tags', replaceDocument(xml => xml.replace('</w:r>', '</w:p>'))],
    [
      'malformed duplicate attribute',
      replaceDocument(xml => xml.replace('xml:space="preserve"', 'xml:space="preserve" xml:space="default"')),
    ],
    ['malformed unescaped ampersand', docx(paragraph('Budget & 450'))],
    ['malformed undeclared prefix', docx(`${budget}<unknown:p/>`)],
    [
      'malformed second XML root',
      replaceDocument(
        xml => `${xml}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`,
      ),
    ],
    ['DTD declaration without entities', replaceDocument(xml => `<!DOCTYPE w:document>${xml}`)],
    [
      'DTD internal entity',
      replaceDocument(xml => `<!DOCTYPE w:document [<!ENTITY fact "450">]>${xml.replace('Budget', 'Budget &fact;')}`),
    ],
    [
      'spoofed WordML document namespace',
      replaceDocument(xml =>
        xml.replace('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'urn:not-wordml'),
      ),
    ],
    [
      'spoofed WordML text namespace',
      docx('<w:p><w:r><w:t xmlns:w="urn:not-wordml">450</w:t><w:t>Budget</w:t></w:r></w:p>'),
    ],
    ['unqualified lookalike text element', docx('<w:p><w:r><t>450</t><w:t>Budget</w:t></w:r></w:p>')],
    [
      'hyperlink ID without relationships',
      docx('<w:p><w:hyperlink r:id="missing"><w:r><w:t>Policy</w:t></w:r></w:hyperlink></w:p>'),
    ],
    [
      'hyperlink ID absent from relationships',
      docx('<w:p><w:hyperlink r:id="missing"><w:r><w:t>Policy</w:t></w:r></w:hyperlink></w:p>', [
        relationships([relationship('hyperlink', 'https://example.com/policy', 'TargetMode="External"')]),
      ]),
    ],
  ];
  for (const kind of ['footnote', 'endnote']) {
    const reference = `<w:p><w:r><w:t>Budget</w:t><w:${kind}Reference w:id="1"/></w:r></w:p>`;
    const rels = relationships([relationship(`${kind}s`, `${kind}s.xml`)]);
    fixtures.push(
      [`orphan ${kind} body`, docx(budget, [rels, note(kind)])],
      [`missing referenced ${kind} body`, docx(reference.replace('w:id="1"', 'w:id="2"'), [rels, note(kind)])],
      [`missing referenced ${kind} part`, docx(reference)],
      [
        `numbering inside ${kind}`,
        docx(
          reference,
          [
            relationships([relationship(`${kind}s`, `${kind}s.xml`), relationship('numbering', 'numbering.xml')]),
            [
              note(kind)[0],
              note(kind)[1].replace(
                paragraph(kind === 'footnote' ? 'Maximum is 450' : 'Due Friday'),
                numberedParagraph('Pay supplier'),
              ),
            ],
            numbering,
          ],
          numberingContentType,
        ),
      ],
    );
  }
  return fixtures;
}

export function supportedAdmissionFixtures() {
  const ordinary = docx(
    '<w:p><w:r><w:t xml:space="preserve">Budget </w:t></w:r><w:r><w:t>450</w:t></w:r></w:p>' + paragraph('Due Friday'),
  );
  return [
    ['ordinary paragraphs and runs', ordinary, 'Budget 450\n\nDue Friday\n\n'],
    [
      'WordML namespace alias',
      rewriteDocx(ordinary, [
        ['word/document.xml', xml => xml.replaceAll('w:', 'word:').replace('xmlns:w=', 'xmlns:word=')],
      ]),
      'Budget 450\n\nDue Friday\n\n',
    ],
    [
      'bold and italic runs',
      docx(
        '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Budget </w:t></w:r><w:r><w:rPr><w:i w:val="1"/></w:rPr><w:t>450</w:t></w:r></w:p>',
      ),
      'Budget 450\n\n',
    ],
    [
      'table cells',
      docx(`<w:tbl><w:tr><w:tc>${paragraph('Budget')}</w:tc><w:tc>${paragraph('450')}</w:tc></w:tr></w:tbl>`),
      'Budget\n\n\t450\n\n\t\n\n',
    ],
  ];
}
