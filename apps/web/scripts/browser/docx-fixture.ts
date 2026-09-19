import { crc32 } from "node:zlib";

/** Independent OOXML, not a round trip through TulipFarm's document writer. */
export function syntheticDocx({
  paragraphs = 0,
  rows = 2,
}: {
  paragraphs?: number;
  rows?: number;
} = {}): Uint8Array {
  const paragraph = (text: string, properties = "") =>
    `<w:p>${properties}<w:r><w:t>${text}</w:t></w:r></w:p>`;
  const list = (text: string, level: number) =>
    paragraph(
      text,
      `<w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="1"/></w:numPr></w:pPr>`
    );
  const parts: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
</Types>`,
    "_rels/.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="main" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    "word/document.xml": `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>
${paragraph("Synthetic browser fact", '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>')}
${paragraph("&lt;script&gt;source text is inert&lt;/script&gt;")}
${list("Ordered task", 0)}${list("Nested supporting task", 1)}
<w:p><w:hyperlink r:id="external"><w:r><w:t>External reference label</w:t></w:r></w:hyperlink><w:r><w:footnoteReference w:id="1"/></w:r></w:p>
<w:p><w:r><w:drawing><wp:inline>
<wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="External picture" descr="External image label"/>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="External picture" descr="External image label"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:link="externalImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
<w:tbl><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
${Array.from({ length: rows }, (_, index) => `<w:tr><w:tc>${paragraph(`Row ${index + 1}`)}</w:tc><w:tc>${paragraph(index === rows - 1 ? "Final table fact" : "Stored value")}</w:tc></w:tr>`).join("")}
</w:tbl>
${Array.from({ length: paragraphs }, (_, index) => paragraph(`Filler paragraph ${index + 1}`)).join("")}
${paragraph("Beyond preview fact")}
<w:sectPr/>
</w:body></w:document>`,
    "word/styles.xml": `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
</w:styles>`,
    "word/numbering.xml": `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0">
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl>
</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
    "word/footnotes.xml": `<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:footnote w:id="1">${paragraph("Synthetic footnote evidence")}</w:footnote></w:footnotes>`,
    "word/_rels/document.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="numbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
<Relationship Id="notes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
<Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/private-tracker" TargetMode="External"/>
<Relationship Id="externalImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.invalid/private-pixel.png" TargetMode="External"/>
</Relationships>`,
  };
  const local: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [path, xml] of Object.entries(parts)) {
    const name = Buffer.from(path);
    const bytes = Buffer.from(xml);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, bytes);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    header.copy(entry, 16, 14, 26);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, name);
    offset += header.length + name.length + bytes.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}
