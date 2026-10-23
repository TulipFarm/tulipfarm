import { docx, paragraph, relationship, relationships } from './knowledge-extraction-fixtures.mjs';
import { cellXlsx } from './parser-completeness.mjs';
import { officeParts, zip } from './parser-documents.mjs';

const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const wordType = kind => `application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml`;
const run = (text, properties = '') =>
  `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const complexField = (instruction, result) =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instruction} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${result}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;

/** A document with two sections whose headers repeat, a page-number-only footer and a footer with text. */
export function headerFooterDocx() {
  const part = (root, body) => `<w:${root} xmlns:w="${w}">${body}</w:${root}>`;
  const section = (header, footer) =>
    `<w:sectPr><w:headerReference w:type="default" r:id="${header}"/><w:footerReference w:type="default" r:id="${footer}"/></w:sectPr>`;
  return docx(
    `<w:p><w:pPr>${section('header1', 'footer1')}</w:pPr>${run('Chapter one')}</w:p>${paragraph('Chapter two')}${section('header2', 'footer2')}`,
    [
      relationships([
        relationship('header', 'header1.xml').replace('Id="header"', 'Id="header1"'),
        relationship('header', 'header2.xml').replace('Id="header"', 'Id="header2"'),
        relationship('footer', 'footer1.xml').replace('Id="footer"', 'Id="footer1"'),
        relationship('footer', 'footer2.xml').replace('Id="footer"', 'Id="footer2"'),
      ]),
      ['word/header1.xml', part('hdr', paragraph('Orchard Co confidential'))],
      ['word/header2.xml', part('hdr', paragraph('Orchard Co confidential'))],
      [
        'word/footer1.xml',
        part(
          'ftr',
          `<w:p>${run('Page ')}${complexField('PAGE', run('3'))}${run(' of ')}<w:fldSimple w:instr=" NUMPAGES ">${run('9')}</w:fldSimple></w:p>`,
        ),
      ],
      [
        'word/footer2.xml',
        part('ftr', `<w:p>${run('Approved by finance')}${run('\t')}${complexField('PAGE', run('4'))}</w:p>`),
      ],
    ],
    ['header1', 'header2', 'footer1', 'footer2']
      .map(name => `<Override PartName="/word/${name}.xml" ContentType="${wordType(name.slice(0, -1))}"/>`)
      .join(''),
  );
}

/** A header whose only content is a picture with alt text. */
export function headerImageDocx() {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=',
    'base64',
  );
  return docx(
    `${paragraph('Body text')}<w:sectPr><w:headerReference w:type="default" r:id="header"/></w:sectPr>`,
    [
      relationships([relationship('header', 'header1.xml')]),
      [
        'word/header1.xml',
        `<w:hdr xmlns:w="${w}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml"><w:p><w:r><w:pict><v:shape alt="Company logo"><v:imagedata r:id="logo"/></v:shape></w:pict></w:r></w:p></w:hdr>`,
      ],
      [
        'word/_rels/header1.xml.rels',
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship('image', 'media/logo.png').replace('Id="image"', 'Id="logo"')}</Relationships>`,
      ],
      ['word/media/logo.png', png],
    ],
    `<Override PartName="/word/header1.xml" ContentType="${wordType('header')}"/><Default Extension="png" ContentType="image/png"/>`,
  );
}

/** Comments anchored in a paragraph and in a table cell, plus one comment nothing refers to. */
export function commentsDocx() {
  const reference = id => `<w:r><w:commentReference w:id="${id}"/></w:r>`;
  const comment = (id, author, text) =>
    `<w:comment w:id="${id}"${author ? ` w:author="${author}"` : ''} w:initials="R"><w:p>${run(text)}</w:p></w:comment>`;
  return docx(
    `<w:p><w:commentRangeStart w:id="1"/>${run('Budget 450')}<w:commentRangeEnd w:id="1"/>${reference(1)}</w:p>${paragraph('Next steps')}<w:tbl><w:tr><w:tc><w:p>${run('Apples')}${reference(2)}</w:p></w:tc></w:tr></w:tbl>`,
    [
      relationships([relationship('comments', 'comments.xml')]),
      [
        'word/comments.xml',
        `<w:comments xmlns:w="${w}">${comment(1, 'Ana *Ruiz*', 'Check the total')}${comment(2, '', 'Count again')}${comment(3, 'Bo', 'Unanchored note')}</w:comments>`,
      ],
    ],
    `<Override PartName="/word/comments.xml" ContentType="${wordType('comments')}"/>`,
  );
}

/** Tracked insertions, deletions, moves, a deleted table row and property-change records. */
export function revisionsDocx() {
  const change = (kind, body) =>
    `<w:${kind} w:id="${kind.length}" w:author="Reviewer" w:date="2024-01-01T00:00:00Z">${body}</w:${kind}>`;
  return docx(
    `<w:p><w:pPr><w:pPrChange w:id="9" w:author="Reviewer"><w:pPr/></w:pPrChange></w:pPr>${run('Limit ')}${change('del', '<w:r><w:delText>300</w:delText></w:r>')}${change('ins', run('450'))}</w:p>` +
      `<w:p>${change('moveFrom', run('Moved away'))}${run('Stays', '<w:rPrChange w:id="8" w:author="Reviewer"><w:rPr/></w:rPrChange>')}${change('moveTo', run(' moved here'))}</w:p>` +
      `<w:tbl><w:tr><w:tc><w:p>${run('Kept row')}</w:p></w:tc></w:tr><w:tr><w:trPr><w:del w:id="7" w:author="Reviewer"/></w:trPr><w:tc><w:p>${change('del', '<w:r><w:delText>Removed row</w:delText></w:r>')}</w:p></w:tc></w:tr></w:tbl>`,
  );
}

/** Simple and complex fields, a TOC inside a content control, a nested field and a legacy checkbox. */
export function fieldsDocx() {
  const nested = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> IF </w:instrText></w:r>${complexField('DATE', run('SECRETINSTR'))}<w:r><w:instrText> = 1 "a" "b" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('Outer result')}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
  return docx(
    `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/></w:docPartObj></w:sdtPr><w:sdtContent><w:p>${complexField('TOC \\o "1-3"', '')}</w:p><w:p>${run('Intro 3')}</w:p><w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:sdtContent></w:sdt>` +
      `<w:p>${run('Revised ')}<w:fldSimple w:instr=" SAVEDATE \\@ &quot;yyyy&quot; ">${run('2024')}</w:fldSimple></w:p>` +
      `<w:p>${run('Total ')}${complexField('=SUM(ABOVE)', run('450'))}</w:p>` +
      `<w:p>${nested}</w:p>` +
      `<w:p><w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:checkBox><w:default w:val="0"/></w:checkBox></w:ffData></w:fldChar></w:r><w:r><w:instrText> FORMCHECKBOX </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>${run(' Not approved')}</w:p>`,
  );
}

/** Underline, raised and lowered text, merged cells and hidden text. */
export function formattingDocx(hidden = true) {
  return docx(
    `<w:p>${run('Area 10')}${run('2', '<w:vertAlign w:val="superscript"/>')}${run(' of H')}${run('2', '<w:vertAlign w:val="subscript"/>')}${run('O', '<w:u w:val="double"/>')}</w:p>` +
      `<w:p>${run('Visible')}${hidden ? run(' SECRET', '<w:vanish/>') : ''}${run(' end')}</w:p>` +
      `<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p>${run('Wide')}</w:p></w:tc></w:tr>` +
      `<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p>${run('Tall')}</w:p></w:tc><w:tc><w:p>${run('One')}</w:p></w:tc></w:tr>` +
      `<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p>${run('Two')}</w:p></w:tc></w:tr></w:tbl>`,
  );
}

/** A workbook whose first sheet hides a row and a column and whose second sheet is hidden. */
export function hiddenXlsx({ sheet = 'hidden', rows = true, date1904 = false } = {}) {
  let entries = officeParts(cellXlsx('<c r="B2"><v>450</v></c><c r="C2" t="inlineStr"><is><t>Side</t></is></c>'));
  const edit = (path, change) => {
    entries = entries.map(([name, text]) => [name, name === path ? change(text) : text]);
  };
  if (rows) {
    edit('xl/worksheets/sheet1.xml', xml =>
      xml
        .replace('<sheetData>', '<cols><col min="3" max="3" width="9" hidden="1"/></cols><sheetData>')
        .replace(
          '</sheetData>',
          '<row r="3" hidden="1"><c r="A3" t="inlineStr"><is><t>Pear secret</t></is></c></row></sheetData>',
        ),
    );
  }
  if (date1904) edit('xl/workbook.xml', xml => xml.replace('<sheets>', '<workbookPr date1904="1"/><sheets>'));
  if (sheet) {
    const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    edit('xl/workbook.xml', xml =>
      xml.replace('</sheets>', `<sheet name="Archive" sheetId="2" state="${sheet}" r:id="archive"/></sheets>`),
    );
    edit('xl/_rels/workbook.xml.rels', xml =>
      xml.replace(
        '</Relationships>',
        `<Relationship Id="archive" Type="${office}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
      ),
    );
    edit('[Content_Types].xml', xml =>
      xml.replace(
        '</Types>',
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      ),
    );
    entries.push([
      'xl/worksheets/sheet2.xml',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Archived secret</t></is></c></row></sheetData></worksheet>',
    ]);
  }
  return zip(entries);
}
