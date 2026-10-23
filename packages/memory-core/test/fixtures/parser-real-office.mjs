import { png } from './parser-media.mjs';
import { zip } from './parser-documents.mjs';

// Packages shaped like Word, PowerPoint, Excel and Google exports: styles, themes, settings, fonts, properties,
// masters and layouts around the content. Every formatting part holds a LEAK marker that must never reach text.
const packageRelationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const metadata = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata';
const officeDocument = 'application/vnd.openxmlformats-officedocument';
const drawingMl = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const presentationMl = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const wordMl = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const sheetMl = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const compatibility = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const pictureUri = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const w14 = 'http://schemas.microsoft.com/office/word/2010/wordml';

const rels = entries =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${packageRelationships}">${entries
    .map(
      ([id, type, target, external]) =>
        `<Relationship Id="${id}" Type="${type.includes('://') ? type : `${office}/${type}`}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`,
    )
    .join('')}</Relationships>`;
const types = (defaults, overrides) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>${defaults}${overrides
    .map(
      ([part, type]) =>
        `<Override PartName="/${part}" ContentType="${type.includes('/') ? type : `${officeDocument}.${type}`}"/>`,
    )
    .join('')}</Types>`;
const properties = [
  [
    'docProps/core.xml',
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>CORE LEAK</dc:title><dc:creator>CREATOR LEAK</dc:creator></cp:coreProperties>',
  ],
  [
    'docProps/app.xml',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>APP LEAK</Application><Company>COMPANY LEAK</Company></Properties>',
  ],
  [
    'docProps/custom.xml',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Client"><vt:lpwstr>CUSTOM LEAK</vt:lpwstr></property></Properties>',
  ],
];
const propertyRelationships = [
  ['rIdCore', `${metadata}/core-properties`, 'docProps/core.xml'],
  ['rIdApp', 'extended-properties', 'docProps/app.xml'],
  ['rIdCustom', 'custom-properties', 'docProps/custom.xml'],
  ['rIdThumb', `${metadata}/thumbnail`, 'docProps/thumbnail.jpeg'],
];
const propertyTypes = [
  ['docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
  ['docProps/app.xml', 'extended-properties+xml'],
  ['docProps/custom.xml', 'custom-properties+xml'],
];
const theme = `<a:theme xmlns:a="${drawingMl}" name="THEME LEAK"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="FONT LEAK"/></a:majorFont></a:fontScheme></a:themeElements></a:theme>`;

/**
 * A Word document as Word saves it: styles, settings, web settings, font table with an embedded font, theme,
 * numbering, separator footnotes, custom XML, properties and thumbnail around a heading, bullet list, picture,
 * hyperlink, footnote and table. `variant` adds a macro project, an ActiveX control or text inside formatting properties.
 */
export async function realDocx(variant = '') {
  const run = (text, properties = '') =>
    `<w:r w:rsidRPr="00A1B2C3">${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
  const typography =
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-GB"/>';
  const paragraph = (content, properties = '') =>
    `<w:p w:rsidR="00A1B2C3" w:rsidRDefault="00A1B2C3" w14:paraId="1A2B3C4D" w14:textId="77777777">${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${content}</w:p>`;
  const bullet = text =>
    paragraph(
      run(text),
      `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:spacing w:after="0"/><w:ind w:left="720" w:hanging="360"/>`,
    );
  const picture = `<w:r><w:rPr><w:noProof/></w:rPr><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="914400" cy="685800"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="1" name="Picture 1" descr="Packhouse floor plan"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${drawingMl}" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="${drawingMl}"><a:graphicData uri="${pictureUri}"><pic:pic xmlns:pic="${pictureUri}"><pic:nvPicPr><pic:cNvPr id="0" name="plan.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="685800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  const cell = text =>
    `<w:tc><w:tcPr><w:tcW w:w="4508" w:type="dxa"/><w:tcBorders><w:top w:val="single" w:sz="4"/></w:tcBorders><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:tcPr>${paragraph(run(text), '<w:spacing w:after="0"/>')}</w:tc>`;
  const hidden = variant === 'text in formatting' ? '<w:shd w:val="clear">450</w:shd>' : '';
  const body = [
    `<w:bookmarkStart w:id="0" w:name="_GoBack"/>`,
    paragraph(run('Packhouse handbook'), '<w:pStyle w:val="Title"/>'),
    paragraph(run('Receiving'), '<w:pStyle w:val="Heading1"/><w:keepNext/>'),
    paragraph(
      `${run('Trucks unload at ', typography)}<w:proofErr w:type="spellStart"/>${run('dock', `${typography}<w:b/><w:bCs/>`)}<w:proofErr w:type="spellEnd"/>${run(' two.', `${typography}<w:b w:val="0"/><w:i w:val="false"/>`)}${variant === 'activeX' ? '<w:r><w:object><w:control r:id="rIdControl" w:name="CheckBox1"/></w:object></w:r>' : ''}<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>`,
      `<w:widowControl/><w:spacing w:before="120" w:after="120" w:line="276" w:lineRule="auto"/><w:jc w:val="both"/><w:rPr><w:lang w:val="en-GB"/></w:rPr>${hidden}`,
    ),
    bullet('Check the seal'),
    bullet('Weigh every pallet'),
    paragraph(picture, '<w:jc w:val="center"/>'),
    paragraph(
      `<w:hyperlink r:id="rIdLink" w:history="1">${run('Safety rules', '<w:rStyle w:val="Hyperlink"/>')}</w:hyperlink>`,
    ),
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4"/></w:tblBorders><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid><w:gridCol w:w="4508"/><w:gridCol w:w="4508"/></w:tblGrid><w:tr w:rsidR="00A1B2C3"><w:trPr><w:trHeight w:val="300"/></w:trPr>${cell('Dock')}${cell('Pallets')}</w:tr><w:tr>${cell('Two')}${cell('40')}</w:tr></w:tbl>`,
    `<w:bookmarkEnd w:id="0"/>`,
    paragraph(''),
    `<w:sectPr w:rsidR="00A1B2C3"><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr>`,
  ].join('');
  const level = (index, format, text) =>
    `<w:lvl w:ilvl="${index}" w:tplc="04090001"${index ? ' w:tentative="1"' : ''}><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (index + 1)}" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl>`;
  const numbering = `<w:numbering xmlns:w="${wordMl}" xmlns:mc="${compatibility}" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" mc:Ignorable="w15"><w:abstractNum w:abstractNumId="0" w15:restartNumberingAfterBreak="0"><w:nsid w:val="1F2E3D4C"/><w:multiLevelType w:val="hybridMultilevel"/><w:tmpl w:val="5A6B7C8D"/>${level(0, 'bullet', '\u{f0b7}')}${level(1, 'bullet', 'o')}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="multilevel"/>${level(0, 'decimal', '%1.')}${level(1, 'lowerLetter', '%2)')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num></w:numbering>`;
  const notes = kind => {
    const separators = `<w:${kind} w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:separator/></w:r></w:p></w:${kind}><w:${kind} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${kind}>`;
    const body =
      kind === 'footnote'
        ? `<w:footnote w:id="1"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> Dock two closes at 18:00.</w:t></w:r></w:p></w:footnote>`
        : '';
    return `<w:${kind}s xmlns:w="${wordMl}" xmlns:r="${office}">${separators}${body}</w:${kind}s>`;
  };
  const macro = variant === 'macro';
  const entries = [
    [
      '[Content_Types].xml',
      types(
        '<Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/><Default Extension="emf" ContentType="image/x-emf"/>' +
          (macro ? '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>' : '') +
          (variant === 'activeX' ? '<Default Extension="bin" ContentType="application/vnd.ms-office.activeX"/>' : ''),
        [
          [
            'word/document.xml',
            macro ? 'application/vnd.ms-word.document.macroEnabled.main+xml' : 'wordprocessingml.document.main+xml',
          ],
          ['word/styles.xml', 'wordprocessingml.styles+xml'],
          ['word/stylesWithEffects.xml', 'application/vnd.ms-word.stylesWithEffects+xml'],
          ['word/settings.xml', 'wordprocessingml.settings+xml'],
          ['word/webSettings.xml', 'wordprocessingml.webSettings+xml'],
          ['word/fontTable.xml', 'wordprocessingml.fontTable+xml'],
          ['word/theme/theme1.xml', 'theme+xml'],
          ['word/numbering.xml', 'wordprocessingml.numbering+xml'],
          ['word/footnotes.xml', 'wordprocessingml.footnotes+xml'],
          ['word/endnotes.xml', 'wordprocessingml.endnotes+xml'],
          ['word/people.xml', 'wordprocessingml.people+xml'],
          ['customXml/itemProps1.xml', 'customXmlProperties+xml'],
          ...(variant === 'activeX' ? [['word/activeX/activeX1.xml', 'application/vnd.ms-office.activeX+xml']] : []),
          ...propertyTypes,
        ],
      ),
    ],
    ['_rels/.rels', rels([['rId1', 'officeDocument', 'word/document.xml'], ...propertyRelationships])],
    ...properties,
    ['docProps/thumbnail.jpeg', Buffer.from('THUMBNAIL LEAK')],
    [
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="${wordMl}" xmlns:r="${office}" xmlns:mc="${compatibility}" xmlns:w14="${w14}" mc:Ignorable="w14"><w:body>${body}</w:body></w:document>`,
    ],
    [
      'word/_rels/document.xml.rels',
      rels([
        ['rId1', 'customXml', '../customXml/item1.xml'],
        ['rId2', 'numbering', 'numbering.xml'],
        ['rId3', 'styles', 'styles.xml'],
        ['rId4', 'http://schemas.microsoft.com/office/2007/relationships/stylesWithEffects', 'stylesWithEffects.xml'],
        ['rId5', 'settings', 'settings.xml'],
        ['rId6', 'webSettings', 'webSettings.xml'],
        ['rId7', 'footnotes', 'footnotes.xml'],
        ['rId8', 'endnotes', 'endnotes.xml'],
        ['rId9', 'fontTable', 'fontTable.xml'],
        ['rId10', 'theme', 'theme/theme1.xml'],
        ['rId11', 'http://schemas.microsoft.com/office/2011/relationships/people', 'people.xml'],
        ['rIdImage', 'image', 'media/image1.png'],
        ['rIdLink', 'hyperlink', 'https://example.com/safety', true],
        ...(macro
          ? [['rIdVba', 'http://schemas.microsoft.com/office/2006/relationships/vbaProject', 'vbaProject.bin']]
          : []),
        ...(variant === 'activeX' ? [['rIdControl', 'control', 'activeX/activeX1.xml']] : []),
      ]),
    ],
    [
      'word/styles.xml',
      `<w:styles xmlns:w="${wordMl}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="StyleLeak"><w:name w:val="STYLE LEAK"/></w:style></w:styles>`,
    ],
    [
      'word/stylesWithEffects.xml',
      `<w:styles xmlns:w="${wordMl}"><w:style w:styleId="Leak"><w:name w:val="EFFECTS LEAK"/></w:style></w:styles>`,
    ],
    [
      'word/settings.xml',
      `<w:settings xmlns:w="${wordMl}" xmlns:r="${office}"><w:zoom w:percent="100"/><w:attachedTemplate r:id="rId1"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr><w:rsids><w:rsidRoot w:val="00A1B2C3"/></w:rsids><w:themeFontLang w:val="en-GB"/><w:decimalSymbol w:val="."/><w:listSeparator w:val=","/></w:settings>`,
    ],
    ['word/_rels/settings.xml.rels', rels([['rId1', 'attachedTemplate', 'file:///C:/Templates/Handbook.dotx', true]])],
    ['word/webSettings.xml', `<w:webSettings xmlns:w="${wordMl}"><w:optimizeForBrowser/></w:webSettings>`],
    [
      'word/fontTable.xml',
      `<w:fonts xmlns:w="${wordMl}" xmlns:r="${office}"><w:font w:name="Calibri"><w:panose1 w:val="020F0502020204030204"/><w:embedRegular r:id="rId1" w:fontKey="{11111111-2222-3333-4444-555555555555}"/></w:font><w:font w:name="FONT TABLE LEAK"/></w:fonts>`,
    ],
    ['word/_rels/fontTable.xml.rels', rels([['rId1', 'font', 'fonts/font1.odttf']])],
    ['word/fonts/font1.odttf', Buffer.from('EMBEDDED FONT LEAK')],
    ['word/theme/theme1.xml', theme],
    ['word/numbering.xml', numbering],
    ['word/footnotes.xml', notes('footnote')],
    ['word/endnotes.xml', notes('endnote')],
    [
      'word/people.xml',
      `<w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:person w15:author="PEOPLE LEAK"/></w15:people>`,
    ],
    ['word/media/image1.png', await png(120, 90)],
    [
      'customXml/item1.xml',
      '<b:Sources xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"/>',
    ],
    ['customXml/_rels/item1.xml.rels', rels([['rId1', 'customXmlProps', 'itemProps1.xml']])],
    [
      'customXml/itemProps1.xml',
      '<ds:datastoreItem ds:itemID="{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"/>',
    ],
  ];
  if (macro) entries.push(['word/vbaProject.bin', Buffer.from('Attribute VB_Name = "Module1"')]);
  if (variant === 'activeX')
    entries.push([
      'word/activeX/activeX1.xml',
      `<ax:ocx xmlns:ax="http://schemas.microsoft.com/office/2006/activeX" ax:classid="{8BD21D40-EC42-11CE-9E0D-00AA006002F3}" ax:persistence="persistStorage"/>`,
    ]);
  return zip(entries);
}

/**
 * A deck as PowerPoint saves it: masters, layouts, notes master, theme, presentation, view and table-style
 * properties, a slide-number field on the slide and in its notes, formatted runs, a click-through link and a picture.
 */
export async function realPptx() {
  const namespaces = `xmlns:a="${drawingMl}" xmlns:r="${office}" xmlns:p="${presentationMl}"`;
  const textBody = (paragraphs, body = '<a:bodyPr wrap="square" rtlCol="0" anchor="ctr"><a:normAutofit/></a:bodyPr>') =>
    `<p:txBody>${body}<a:lstStyle/>${paragraphs}</p:txBody>`;
  const spPr =
    '<p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>';
  const placeholder = (id, name, ph, paragraphs, locks = '<a:spLocks noGrp="1"/>') =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr>${locks}</p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr>${spPr}${textBody(paragraphs)}</p:sp>`;
  const field = `<a:p><a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-GB"/><a:t>‹#›</a:t></a:fld><a:endParaRPr lang="en-GB"/></a:p>`;
  const slideNumber = id =>
    placeholder(id, 'Slide Number Placeholder', '<p:ph type="sldNum" sz="quarter" idx="12"/>', field);
  const tree = shapes =>
    `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes}</p:spTree></p:cSld>`;
  const master = `<p:sldMaster ${namespaces}>${tree(placeholder(2, 'Title Placeholder 1', '<p:ph type="title"/>', '<a:p><a:r><a:rPr lang="en-GB"/><a:t>MASTER LEAK</a:t></a:r></a:p>'))}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400" b="1"/></a:lvl1pPr></p:titleStyle></p:txStyles></p:sldMaster>`;
  const run = (text, properties = 'lang="en-GB" dirty="0"', children = '') =>
    `<a:r><a:rPr ${properties}>${children}</a:rPr><a:t>${text}</a:t></a:r>`;
  const slide = `<p:sld ${namespaces}>${tree(
    placeholder(
      2,
      'Title 1',
      '<p:ph type="title"/>',
      `<a:p><a:pPr marL="0" indent="0"><a:buNone/></a:pPr>${run('Packhouse safety', 'lang="en-GB" sz="3200" dirty="0"', '<a:solidFill><a:srgbClr val="1F4E79"/></a:solidFill><a:latin typeface="Calibri"/>')}<a:endParaRPr lang="en-GB" sz="3200" dirty="0"/></a:p>`,
    ) +
      placeholder(
        3,
        'Content Placeholder 2',
        '<p:ph idx="1"/>',
        `<a:p>${run('Wear boots on ', 'lang="en-GB" dirty="0"')}${run('every', 'lang="en-GB" b="1" dirty="0"')}${run(' shift', 'lang="en-GB" b="0" i="0" u="none" strike="noStrike" baseline="0" cap="none" spc="0" dirty="0"')}</a:p><a:p>${run('Read the rules', 'lang="en-GB" dirty="0"', '<a:hlinkClick r:id="rIdLink"/>')}</a:p>`,
      ) +
      `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture 3" descr="Boot rack by the door"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>${spPr}</p:pic>` +
      slideNumber(5),
  )}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr><p:transition spd="med"><p:fade/></p:transition></p:sld>`;
  const notes = `<p:notes ${namespaces}>${tree(
    placeholder(
      2,
      'Slide Image Placeholder 1',
      '<p:ph type="sldImg"/>',
      '<a:p><a:endParaRPr lang="en-GB"/></a:p>',
      '<a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/>',
    ) +
      placeholder(
        3,
        'Notes Placeholder 2',
        '<p:ph type="body" idx="1"/>',
        `<a:p>${run('Point at the boot rack.')}</a:p>`,
      ) +
      slideNumber(4),
  )}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
  return zip([
    [
      '[Content_Types].xml',
      types('', [
        ['ppt/presentation.xml', 'presentationml.presentation.main+xml'],
        ['ppt/slideMasters/slideMaster1.xml', 'presentationml.slideMaster+xml'],
        ['ppt/slideLayouts/slideLayout1.xml', 'presentationml.slideLayout+xml'],
        ['ppt/notesMasters/notesMaster1.xml', 'presentationml.notesMaster+xml'],
        ['ppt/slides/slide1.xml', 'presentationml.slide+xml'],
        ['ppt/notesSlides/notesSlide1.xml', 'presentationml.notesSlide+xml'],
        ['ppt/theme/theme1.xml', 'theme+xml'],
        ['ppt/theme/theme2.xml', 'theme+xml'],
        ['ppt/presProps.xml', 'presentationml.presProps+xml'],
        ['ppt/viewProps.xml', 'presentationml.viewProps+xml'],
        ['ppt/tableStyles.xml', 'presentationml.tableStyles+xml'],
        ...propertyTypes.slice(0, 2),
      ]),
    ],
    ['_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml'], ...propertyRelationships.slice(0, 2)])],
    ...properties.slice(0, 2),
    [
      'ppt/presentation.xml',
      `<p:presentation ${namespaces} saveSubsetFonts="1" autoCompressPictures="0"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId3"/></p:notesMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-GB"/></a:defPPr><a:lvl1pPr marL="0" algn="l"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:defaultTextStyle><p:extLst><p:ext uri="{EFAFB233-063F-42B5-8137-9DF3F51BA10A}"><p15:sldGuideLst xmlns:p15="http://schemas.microsoft.com/office/powerpoint/2012/main"/></p:ext></p:extLst></p:presentation>`,
    ],
    [
      'ppt/_rels/presentation.xml.rels',
      rels([
        ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
        ['rId2', 'slide', 'slides/slide1.xml'],
        ['rId3', 'notesMaster', 'notesMasters/notesMaster1.xml'],
        ['rId4', 'presProps', 'presProps.xml'],
        ['rId5', 'viewProps', 'viewProps.xml'],
        ['rId6', 'theme', 'theme/theme1.xml'],
        ['rId7', 'tableStyles', 'tableStyles.xml'],
      ]),
    ],
    ['ppt/slideMasters/slideMaster1.xml', master],
    [
      'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      rels([
        ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
        ['rId2', 'theme', '../theme/theme1.xml'],
      ]),
    ],
    [
      'ppt/slideLayouts/slideLayout1.xml',
      `<p:sldLayout ${namespaces} type="title" preserve="1">${tree(placeholder(2, 'Title 1', '<p:ph type="ctrTitle"/>', '<a:p><a:r><a:rPr lang="en-GB"/><a:t>LAYOUT LEAK</a:t></a:r></a:p>'))}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    ],
    [
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    ],
    [
      'ppt/notesMasters/notesMaster1.xml',
      `<p:notesMaster ${namespaces}>${tree(placeholder(2, 'Header Placeholder 1', '<p:ph type="hdr" sz="quarter"/>', '<a:p><a:r><a:rPr lang="en-GB"/><a:t>NOTES MASTER LEAK</a:t></a:r></a:p>'))}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:notesMaster>`,
    ],
    ['ppt/notesMasters/_rels/notesMaster1.xml.rels', rels([['rId1', 'theme', '../theme/theme2.xml']])],
    ['ppt/slides/slide1.xml', slide],
    [
      'ppt/slides/_rels/slide1.xml.rels',
      rels([
        ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
        ['rIdImage', 'image', '../media/image1.png'],
        ['rIdNotes', 'notesSlide', '../notesSlides/notesSlide1.xml'],
        ['rIdLink', 'hyperlink', 'https://example.com/rules', true],
      ]),
    ],
    ['ppt/notesSlides/notesSlide1.xml', notes],
    [
      'ppt/notesSlides/_rels/notesSlide1.xml.rels',
      rels([
        ['rId1', 'notesMaster', '../notesMasters/notesMaster1.xml'],
        ['rId2', 'slide', '../slides/slide1.xml'],
      ]),
    ],
    ['ppt/theme/theme1.xml', theme],
    ['ppt/theme/theme2.xml', theme],
    [
      'ppt/presProps.xml',
      `<p:presentationPr ${namespaces}><p:extLst><p:ext uri="{E76CE94A-603C-4142-B9EB-6D1370010A27}"><p14:discardImageEditData xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" val="0"/></p:ext></p:extLst></p:presentationPr>`,
    ],
    [
      'ppt/viewProps.xml',
      `<p:viewPr ${namespaces}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr></p:viewPr>`,
    ],
    ['ppt/tableStyles.xml', `<a:tblStyleLst xmlns:a="${drawingMl}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`],
    ['ppt/media/image1.png', await png(100, 80)],
  ]);
}

/**
 * A workbook as Excel saves it: theme, a stylesheet with unused bold and struck heading fonts, differential and table
 * styles, shared strings, a calculation chain, printer settings, a print area, page setup, print header and a
 * drawing with a picture.
 */
export async function realXlsx() {
  const sheet = `<worksheet xmlns="${sheetMl}" xmlns:r="${office}" xmlns:mc="${compatibility}" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" mc:Ignorable="x14ac"><sheetPr><tabColor rgb="FF00B050"/><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:B3"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="B3" sqref="B3"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"/><cols><col min="1" max="1" width="18.7109375" customWidth="1"/></cols><sheetData><row r="1" spans="1:2" s="1" customFormat="1" x14ac:dyDescent="0.25"><c r="A1" s="1" t="s"><v>0</v></c><c r="B1" s="1" t="s"><v>1</v></c></row><row r="2" spans="1:2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>40</v></c></row><row r="3" spans="1:2"><c r="A3" t="s"><v>3</v></c><c r="B3"><f>SUM(B2:B2)</f><v>40</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="C1:D1"/></mergeCells><conditionalFormatting sqref="B2:B3"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>100</formula></cfRule></conditionalFormatting><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="portrait" r:id="rId1"/><headerFooter><oddHeader>&amp;CHEADER LEAK</oddHeader></headerFooter><drawing r:id="rId2"/></worksheet>`;
  return zip([
    [
      '[Content_Types].xml',
      types(
        '<Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings"/>',
        [
          ['xl/workbook.xml', 'spreadsheetml.sheet.main+xml'],
          ['xl/worksheets/sheet1.xml', 'spreadsheetml.worksheet+xml'],
          ['xl/theme/theme1.xml', 'theme+xml'],
          ['xl/styles.xml', 'spreadsheetml.styles+xml'],
          ['xl/sharedStrings.xml', 'spreadsheetml.sharedStrings+xml'],
          ['xl/calcChain.xml', 'spreadsheetml.calcChain+xml'],
          ['xl/drawings/drawing1.xml', 'drawing+xml'],
          ...propertyTypes.slice(0, 2),
        ],
      ),
    ],
    ['_rels/.rels', rels([['rId1', 'officeDocument', 'xl/workbook.xml'], ...propertyRelationships.slice(0, 2)])],
    ...properties.slice(0, 2),
    [
      'xl/workbook.xml',
      `<workbook xmlns="${sheetMl}" xmlns:r="${office}" xmlns:mc="${compatibility}" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main" mc:Ignorable="x15"><fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="27425"/><workbookPr defaultThemeVersion="166925"/><mc:AlternateContent><mc:Choice Requires="x15"><x15ac:absPath xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac" url="C:\\Users\\"/></mc:Choice></mc:AlternateContent><bookViews><workbookView xWindow="-120" yWindow="-120" windowWidth="29040" windowHeight="15840"/></bookViews><sheets><sheet name="Docks" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">Docks!$A$1:$B$3</definedName></definedNames><calcPr calcId="191029"/><extLst><ext uri="{140A7094-0E35-4892-8432-C4D2E57EDEB5}"><x15:workbookPr chartTrackingRefBase="1"/></ext></extLst></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      rels([
        ['rId1', 'worksheet', 'worksheets/sheet1.xml'],
        ['rId2', 'theme', 'theme/theme1.xml'],
        ['rId3', 'styles', 'styles.xml'],
        ['rId4', 'sharedStrings', 'sharedStrings.xml'],
        ['rId5', 'calcChain', 'calcChain.xml'],
      ]),
    ],
    ['xl/worksheets/sheet1.xml', sheet],
    [
      'xl/worksheets/_rels/sheet1.xml.rels',
      rels([
        ['rId1', 'printerSettings', '../printerSettings/printerSettings1.bin'],
        ['rId2', 'drawing', '../drawings/drawing1.xml'],
      ]),
    ],
    ['xl/printerSettings/printerSettings1.bin', Buffer.from('PRINTER LEAK')],
    ['xl/theme/theme1.xml', theme],
    [
      'xl/styles.xml',
      `<styleSheet xmlns="${sheetMl}" xmlns:mc="${compatibility}" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" mc:Ignorable="x14ac"><fonts count="3" x14ac:knownFonts="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font><font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font><font><b/><strike/><u/><sz val="15"/><color theme="3"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color indexed="64"/></left><right/><top/><bottom style="medium"><color indexed="64"/></bottom><diagonal/></border></borders><cellStyleXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="2" fillId="0" borderId="1" applyNumberFormat="0" applyFill="0" applyAlignment="0" applyProtection="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf></cellXfs><cellStyles count="2"><cellStyle name="Heading 1" xfId="1" builtinId="16"/><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="1"><dxf><font><color rgb="FF9C0006"/></font></dxf></dxfs><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/><extLst><ext uri="{EB79DEF2-80B8-43e5-95BD-54CBDDF9020C}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:slicerStyles defaultSlicerStyle="SlicerStyleLight1"/></ext></extLst></styleSheet>`,
    ],
    [
      'xl/sharedStrings.xml',
      `<sst xmlns="${sheetMl}" count="4" uniqueCount="4"><si><t>Dock</t></si><si><t>Pallets</t></si><si><t>Two</t></si><si><t>Total</t></si></sst>`,
    ],
    ['xl/calcChain.xml', `<calcChain xmlns="${sheetMl}"><c r="B3" i="1"/></calcChain>`],
    [
      'xl/drawings/drawing1.xml',
      `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="${drawingMl}" xmlns:r="${office}"><xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>8</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Picture 1" descr="Dock two loading bay"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`,
    ],
    ['xl/drawings/_rels/drawing1.xml.rels', rels([['rId1', 'image', '../media/image1.png']])],
    ['xl/media/image1.png', await png(90, 60)],
  ]);
}
